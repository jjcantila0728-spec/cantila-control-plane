/* ============================================================
   Cantilapay — HTTP routes (plan §25, Phase 0).

   Registered onto the main Fastify instance via
   `registerCantilapayRoutes(app, deps)` from src/index.ts.

   Phase 0 surface — minimal, smoke-testable:

     Console-managed (cantilapay tenant-side, via Console session
     scoped to the owning Cantila Account):
       POST   /v1/cantilapay/enable                — enable the product
       GET    /v1/cantilapay/me                    — my cantilapay status
       POST   /v1/cantilapay/api_keys              — issue a tenant key
       GET    /v1/cantilapay/api_keys              — list my keys
       DELETE /v1/cantilapay/api_keys/:id          — revoke a key
       POST   /v1/cantilapay/onboarding_link       — hosted KYC URL
       POST   /v1/cantilapay/webhook_endpoints     — register a tenant webhook
       GET    /v1/cantilapay/webhook_endpoints     — list my webhooks
       GET    /v1/cantilapay/audit                 — recent audit entries

     Tenant API (consumed by tenants with their `csk_…`):
       GET    /v1/cantilapay/accounts/me           — my sub-merchant status
       GET    /v1/cantilapay/events                — recent events
       GET    /v1/cantilapay/health                — version + adapter label

     Inbound from PSP:
       POST   /v1/cantilapay/webhooks/adyen        — Adyen → cantilapay

   Phase 1+ extends with /payment_intents, /customers,
   /subscriptions, etc. The Console-managed surface is gated on
   the existing Cantila session/admin-key auth (same chain as
   `/v1/api-keys`); the tenant API is gated on the cantilapay
   tenant key (`csk_test_…` / `csk_live_…`).
   ============================================================ */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import type { PaymentProcessorSelection } from "./adapters";
import { CantilapayError } from "./errors";
import { requireCantilapaySecretKey, requireCantilapayAnyKey } from "./auth/api-key";
import {
  enableForTenant,
  getForTenant,
  getById,
  createOnboardingLink as createOnboardingLinkSvc,
} from "./services/accounts";
import {
  issueCantilapayKey,
  listCantilapayKeys,
  revokeCantilapayKey,
} from "./services/keys";
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
} from "./services/webhooks-out";
import {
  handleInboundWebhook,
  InboundSignatureError,
} from "./services/webhooks-in";
import { listCantilapayAudit } from "./services/audit";
import {
  createCustomer,
  deleteCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from "./services/customers";
import {
  createPaymentMethod,
  detachPaymentMethod,
  getPaymentMethod,
  listPaymentMethods,
} from "./services/payment-methods";
import {
  cancelPaymentIntent,
  capturePaymentIntent,
  confirmPaymentIntent,
  createPaymentIntent,
  getPaymentIntent,
  listPaymentIntents,
} from "./services/payment-intents";
import {
  createRefund,
  getRefund,
  listRefunds,
} from "./services/refunds";
import {
  createProduct,
  getProduct,
  listProducts,
  updateProduct,
} from "./services/products";
import {
  createPrice,
  getPrice,
  listPrices,
} from "./services/prices";
import {
  cancelSubscription,
  createSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription,
} from "./services/subscriptions";
import {
  getInvoice,
  listInvoices,
  markInvoiceUncollectible,
  voidInvoice,
} from "./services/invoices";
import {
  getBalance,
  listBalanceTransactions,
} from "./services/balance";
import {
  createPayout,
  getPayout,
  listPayouts,
} from "./services/payouts";
import {
  completeCheckoutSession,
  createCheckoutSession,
  getCheckoutSession,
  listCheckoutSessions,
} from "./services/checkout-sessions";
import {
  createBillingPortalSession,
  getBillingPortalSession,
} from "./services/billing-portal-sessions";
import { calculateTax, getTaxCalculation } from "./services/tax";
import { selectTaxProvider, type TaxProviderSelection } from "./adapters/tax-port";
import {
  IdempotencyBodyMismatchError,
  PrismaIdempotencyStore,
  withIdempotency,
  type IdempotencyStore,
} from "./services/idempotency";
import type { CantilapayMode } from "./types";

interface RouteDeps {
  prisma: PrismaClient;
  selection: PaymentProcessorSelection;
  /** Resolve the owning Cantila Account.id for a Console session /
   *  admin key request. Reused from src/index.ts to avoid re-implementing
   *  the auth chain. Returns null when no credential is on the request. */
  resolveConsoleAccountId: (req: FastifyRequest) => string | null;
  /** Optional idempotency-key store. Defaults to a Prisma-backed store
   *  inside `registerCantilapayRoutes`. Tests can inject the in-memory
   *  variant to avoid the round-trip. */
  idempotencyStore?: IdempotencyStore;
  /** Optional tax provider selection. Defaults to env-driven
   *  `selectTaxProvider(process.env)` (stub when no ANROK_API_KEY). */
  taxSelection?: TaxProviderSelection;
}

const emptyBody = z.object({}).optional();

const enableSchema = z.object({
  country: z.string().min(2).max(3).optional(),
});

const issueKeySchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["publishable", "secret"]),
  mode: z.enum(["test", "live"]),
});

const onboardingLinkSchema = z.object({
  mode: z.enum(["test", "live"]),
  country: z.string().min(2).max(3),
  returnUrl: z.string().url(),
});

const webhookEndpointSchema = z.object({
  url: z.string().url(),
  mode: z.enum(["test", "live"]),
  enabledEvents: z.string().min(1).optional(),
});

/** Resolve the cantilapay account id for the signed-in Cantila tenant.
 *  Returns 404 if the tenant has not enabled cantilapay yet. */
async function resolveTenantCantilapayId(
  deps: RouteDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ cantilapayAccountId: string; accountId: string } | null> {
  const accountId = deps.resolveConsoleAccountId(req);
  if (!accountId) {
    reply.code(401).send({
      error: CantilapayError.missingKey().body,
    });
    return null;
  }
  const row = await getForTenant(deps.prisma, { accountId });
  if (!row) {
    reply.code(404).send({
      error: CantilapayError.notFound("cantilapay account").body,
    });
    return null;
  }
  return { cantilapayAccountId: row.id, accountId };
}

export function registerCantilapayRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): void {
  const { prisma, selection } = deps;
  const idempotencyStore: IdempotencyStore =
    deps.idempotencyStore ?? new PrismaIdempotencyStore(prisma);
  const taxSelection: TaxProviderSelection =
    deps.taxSelection ?? selectTaxProvider(process.env);

  /** Read the `Cantilapay-Idempotency-Key` header, if present. */
  function idemKey(req: FastifyRequest): string | null {
    const raw = req.headers["cantilapay-idempotency-key"];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
    if (Array.isArray(raw) && raw[0]) return String(raw[0]).trim();
    return null;
  }

  /** Wrap a mutating handler in the idempotency layer. */
  async function withIdem<T>(
    req: FastifyRequest,
    reply: FastifyReply,
    cantilapayAccountId: string,
    mode: CantilapayMode,
    compute: () => Promise<{ status: number; body: T }>,
  ): Promise<void> {
    try {
      const outcome = await withIdempotency<T>({
        store: idempotencyStore,
        cantilapayAccountId,
        mode,
        key: idemKey(req),
        bodyForHash: JSON.stringify(req.body ?? {}),
        compute,
      });
      reply.code(outcome.result.status).send(outcome.result.body);
    } catch (err) {
      if (err instanceof IdempotencyBodyMismatchError) {
        const e = CantilapayError.idempotencyBodyMismatch();
        reply.code(e.status).send({ error: e.body });
        return;
      }
      if (err instanceof CantilapayError) {
        reply.code(err.status).send({ error: err.body });
        return;
      }
      const msg = err instanceof Error ? err.message : "internal error";
      reply.code(500).send({ error: CantilapayError.internal(msg).body });
    }
  }

  /** Render a thrown CantilapayError as the right HTTP shape. */
  function renderErr(reply: FastifyReply, err: unknown): void {
    if (err instanceof CantilapayError) {
      reply.code(err.status).send({ error: err.body });
      return;
    }
    const msg = err instanceof Error ? err.message : "internal error";
    reply.code(500).send({ error: CantilapayError.internal(msg).body });
  }

  /* ----- health (un-authed) ----- */

  app.get("/v1/cantilapay/health", async () => ({
    status: "ok",
    service: "cantilapay",
    adapter: selection.label,
    live: selection.live,
  }));

  /* ----- Console-managed surface (uses the existing Cantila session
            or admin-key chain — deps.resolveConsoleAccountId) ----- */

  app.post("/v1/cantilapay/enable", async (req, reply) => {
    const accountId = deps.resolveConsoleAccountId(req);
    if (!accountId) {
      return reply.code(401).send({ error: CantilapayError.missingKey().body });
    }
    const parsed = enableSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    const row = await enableForTenant(prisma, {
      accountId,
      country: parsed.data.country,
    });
    return reply.code(201).send(row);
  });

  app.get("/v1/cantilapay/me", async (req, reply) => {
    const accountId = deps.resolveConsoleAccountId(req);
    if (!accountId) {
      return reply.code(401).send({ error: CantilapayError.missingKey().body });
    }
    const row = await getForTenant(prisma, { accountId });
    if (!row) {
      return reply
        .code(404)
        .send({ error: CantilapayError.notFound("cantilapay account").body });
    }
    return row;
  });

  app.post("/v1/cantilapay/api_keys", async (req, reply) => {
    const resolved = await resolveTenantCantilapayId(deps, req, reply);
    if (!resolved) return;
    const parsed = issueKeySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    const issued = await issueCantilapayKey(prisma, {
      cantilapayAccountId: resolved.cantilapayAccountId,
      name: parsed.data.name,
      kind: parsed.data.kind,
      mode: parsed.data.mode,
    });
    return reply.code(201).send(issued);
  });

  app.get("/v1/cantilapay/api_keys", async (req, reply) => {
    const resolved = await resolveTenantCantilapayId(deps, req, reply);
    if (!resolved) return;
    const keys = await listCantilapayKeys(prisma, {
      cantilapayAccountId: resolved.cantilapayAccountId,
    });
    return { keys };
  });

  app.delete("/v1/cantilapay/api_keys/:id", async (req, reply) => {
    const resolved = await resolveTenantCantilapayId(deps, req, reply);
    if (!resolved) return;
    const { id } = req.params as { id: string };
    const revoked = await revokeCantilapayKey(prisma, {
      cantilapayAccountId: resolved.cantilapayAccountId,
      apiKeyId: id,
    });
    if (!revoked) {
      return reply
        .code(404)
        .send({ error: CantilapayError.notFound("api key").body });
    }
    return revoked;
  });

  app.post("/v1/cantilapay/onboarding_link", async (req, reply) => {
    const resolved = await resolveTenantCantilapayId(deps, req, reply);
    if (!resolved) return;
    const parsed = onboardingLinkSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    try {
      const link = await createOnboardingLinkSvc(prisma, selection.processor, {
        cantilapayAccountId: resolved.cantilapayAccountId,
        mode: parsed.data.mode,
        country: parsed.data.country,
        returnUrl: parsed.data.returnUrl,
      });
      return reply.code(201).send(link);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "onboarding link failed";
      return reply
        .code(500)
        .send({ error: CantilapayError.internal(msg).body });
    }
  });

  app.post("/v1/cantilapay/webhook_endpoints", async (req, reply) => {
    const resolved = await resolveTenantCantilapayId(deps, req, reply);
    if (!resolved) return;
    const parsed = webhookEndpointSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    const issued = await createWebhookEndpoint(prisma, {
      cantilapayAccountId: resolved.cantilapayAccountId,
      url: parsed.data.url,
      mode: parsed.data.mode,
      enabledEvents: parsed.data.enabledEvents,
    });
    return reply.code(201).send(issued);
  });

  app.get("/v1/cantilapay/webhook_endpoints", async (req, reply) => {
    const resolved = await resolveTenantCantilapayId(deps, req, reply);
    if (!resolved) return;
    const endpoints = await listWebhookEndpoints(prisma, {
      cantilapayAccountId: resolved.cantilapayAccountId,
    });
    return { endpoints };
  });

  app.get("/v1/cantilapay/audit", async (req, reply) => {
    const resolved = await resolveTenantCantilapayId(deps, req, reply);
    if (!resolved) return;
    const q = (req.query ?? {}) as { limit?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    const entries = await listCantilapayAudit(prisma, {
      cantilapayAccountId: resolved.cantilapayAccountId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return { entries };
  });

  /* ----- Tenant API surface (cantilapay key auth) ----- */

  app.get("/v1/cantilapay/accounts/me", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const row = await getById(prisma, key.cantilapayAccountId);
    if (!row) {
      return reply
        .code(404)
        .send({ error: CantilapayError.notFound("cantilapay account").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/events", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { limit?: string };
    const take = Math.max(1, Math.min(Number(q.limit) || 100, 200));
    const rows = await prisma.cantilapayEvent.findMany({
      where: { cantilapayAccountId: key.cantilapayAccountId, mode: key.mode },
      orderBy: { createdAt: "desc" },
      take,
    });
    return {
      events: rows.map((row) => ({
        id: row.id,
        type: row.type,
        mode: row.mode,
        data: safeParseJson(row.data) ?? row.data,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  /* ----- Tenant API — Customers (Phase 1) ----- */

  const createCustomerSchema = z.object({
    externalRef: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(500).optional(),
    metadata: z.record(z.string().max(500)).optional(),
  });
  const updateCustomerSchema = z.object({
    email: z.string().email().nullable().optional(),
    name: z.string().min(1).max(255).nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    metadata: z.record(z.string().max(500)).optional(),
  });

  app.post("/v1/cantilapay/customers", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = createCustomerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      const row = await createCustomer(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        ...parsed.data,
      });
      return { status: 201, body: row };
    });
  });

  app.get("/v1/cantilapay/customers/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getCustomer(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("customer").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/customers", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { limit?: string };
    const rows = await listCustomers(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { customers: rows };
  });

  app.post("/v1/cantilapay/customers/:id", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const parsed = updateCustomerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    try {
      const row = await updateCustomer(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        id,
        ...parsed.data,
      });
      return row;
    } catch (err) {
      return renderErr(reply, err);
    }
  });

  app.delete("/v1/cantilapay/customers/:id", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const out = await deleteCustomer(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!out) {
      return reply.code(404).send({ error: CantilapayError.notFound("customer").body });
    }
    return out;
  });

  /* ----- Tenant API — Payment Methods (Phase 1) ----- */

  const createPaymentMethodSchema = z.object({
    type: z.string().default("card"),
    pspToken: z.string().min(1).max(255),
    customerId: z.string().min(1).optional(),
    card: z
      .object({
        brand: z.string().max(20).optional(),
        last4: z.string().length(4).optional(),
        expMonth: z.number().int().min(1).max(12).optional(),
        expYear: z.number().int().min(2024).max(2100).optional(),
      })
      .optional(),
    metadata: z.record(z.string().max(500)).optional(),
  });

  app.post("/v1/cantilapay/payment_methods", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = createPaymentMethodSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      const row = await createPaymentMethod(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        ...parsed.data,
      });
      return { status: 201, body: row };
    });
  });

  app.get("/v1/cantilapay/payment_methods/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getPaymentMethod(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("payment method").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/payment_methods", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { customer?: string; limit?: string };
    const rows = await listPaymentMethods(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      customerId: q.customer,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { payment_methods: rows };
  });

  app.post("/v1/cantilapay/payment_methods/:id/detach", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await detachPaymentMethod(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("payment method").body });
    }
    return row;
  });

  /* ----- Tenant API — Payment Intents (Phase 1) ----- */

  const createPaymentIntentSchema = z.object({
    amount: z.number().int().positive(),
    currency: z.string().regex(/^[a-z]{3}$/),
    customerId: z.string().min(1).optional(),
    paymentMethodId: z.string().min(1).optional(),
    captureMode: z.enum(["automatic", "manual"]).optional(),
    description: z.string().max(500).optional(),
    metadata: z.record(z.string().max(500)).optional(),
  });
  const confirmPaymentIntentSchema = z.object({
    paymentMethodId: z.string().min(1).optional(),
  });

  app.post("/v1/cantilapay/payment_intents", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = createPaymentIntentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      const row = await createPaymentIntent(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        clientIdempotencyKey: idemKey(req),
        ...parsed.data,
      });
      return { status: 201, body: row };
    });
  });

  app.get("/v1/cantilapay/payment_intents/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getPaymentIntent(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("payment intent").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/payment_intents", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { customer?: string; limit?: string };
    const rows = await listPaymentIntents(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      customerId: q.customer,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { payment_intents: rows };
  });

  app.post("/v1/cantilapay/payment_intents/:id/confirm", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const parsed = confirmPaymentIntentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      const row = await confirmPaymentIntent(prisma, selection.processor, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        id,
        paymentMethodId: parsed.data.paymentMethodId,
      });
      return { status: 200, body: row };
    });
  });

  app.post("/v1/cantilapay/payment_intents/:id/capture", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    try {
      const row = await capturePaymentIntent(prisma, selection.processor, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        id,
      });
      return row;
    } catch (err) {
      return renderErr(reply, err);
    }
  });

  app.post("/v1/cantilapay/payment_intents/:id/cancel", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    try {
      const row = await cancelPaymentIntent(prisma, selection.processor, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        id,
      });
      return row;
    } catch (err) {
      return renderErr(reply, err);
    }
  });

  /* ----- Tenant API — Refunds (Phase 1) ----- */

  const createRefundSchema = z.object({
    paymentIntentId: z.string().min(1),
    amount: z.number().int().positive().optional(),
    reason: z.string().max(120).optional(),
  });

  app.post("/v1/cantilapay/refunds", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = createRefundSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      const row = await createRefund(prisma, selection.processor, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        ...parsed.data,
      });
      return { status: 201, body: row };
    });
  });

  app.get("/v1/cantilapay/refunds/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getRefund(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("refund").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/refunds", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { payment_intent?: string; limit?: string };
    const rows = await listRefunds(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      paymentIntentId: q.payment_intent,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { refunds: rows };
  });

  /* ----- Tenant API — Products + Prices (Phase 2) ----- */

  const createProductSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(500).optional(),
    active: z.boolean().optional(),
    metadata: z.record(z.string().max(500)).optional(),
  });
  const updateProductSchema = z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(500).nullable().optional(),
    active: z.boolean().optional(),
    metadata: z.record(z.string().max(500)).optional(),
  });

  app.post("/v1/cantilapay/products", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = createProductSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      const row = await createProduct(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        ...parsed.data,
      });
      return { status: 201, body: row };
    });
  });

  app.get("/v1/cantilapay/products/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getProduct(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("product").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/products", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { active?: string; limit?: string };
    const rows = await listProducts(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      activeOnly: q.active === "true",
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { products: rows };
  });

  app.post("/v1/cantilapay/products/:id", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const parsed = updateProductSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    try {
      const row = await updateProduct(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        id,
        ...parsed.data,
      });
      return row;
    } catch (err) {
      return renderErr(reply, err);
    }
  });

  const createPriceSchema = z.object({
    productId: z.string().min(1),
    unitAmount: z.number().int().positive(),
    currency: z.string().regex(/^[a-z]{3}$/),
    recurring: z.object({
      interval: z.enum(["day", "week", "month", "year"]),
      intervalCount: z.number().int().positive().optional(),
      trialPeriodDays: z.number().int().min(0).optional(),
    }),
    metadata: z.record(z.string().max(500)).optional(),
  });

  app.post("/v1/cantilapay/prices", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = createPriceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      try {
        const row = await createPrice(prisma, {
          cantilapayAccountId: key.cantilapayAccountId,
          mode: key.mode,
          ...parsed.data,
        });
        return { status: 201, body: row };
      } catch (err) {
        if (err instanceof CantilapayError) {
          return { status: err.status, body: { error: err.body } as never };
        }
        throw err;
      }
    });
  });

  app.get("/v1/cantilapay/prices/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getPrice(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("price").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/prices", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { product?: string; active?: string; limit?: string };
    const rows = await listPrices(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      productId: q.product,
      activeOnly: q.active === "true",
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { prices: rows };
  });

  /* ----- Tenant API — Subscriptions (Phase 2) ----- */

  const createSubscriptionSchema = z.object({
    customerId: z.string().min(1),
    priceId: z.string().min(1),
    defaultPaymentMethodId: z.string().min(1).optional(),
    trialPeriodDays: z.number().int().min(0).optional(),
    metadata: z.record(z.string().max(500)).optional(),
  });
  const updateSubscriptionSchema = z.object({
    cancelAtPeriodEnd: z.boolean().optional(),
    defaultPaymentMethodId: z.string().min(1).nullable().optional(),
    metadata: z.record(z.string().max(500)).optional(),
  });

  app.post("/v1/cantilapay/subscriptions", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = createSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      try {
        const row = await createSubscription(prisma, {
          cantilapayAccountId: key.cantilapayAccountId,
          mode: key.mode,
          ...parsed.data,
        });
        return { status: 201, body: row };
      } catch (err) {
        if (err instanceof CantilapayError) {
          return { status: err.status, body: { error: err.body } as never };
        }
        throw err;
      }
    });
  });

  app.get("/v1/cantilapay/subscriptions/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getSubscription(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("subscription").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/subscriptions", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { customer?: string; status?: string; limit?: string };
    const rows = await listSubscriptions(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      customerId: q.customer,
      status: q.status as never,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { subscriptions: rows };
  });

  app.post("/v1/cantilapay/subscriptions/:id", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const parsed = updateSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    try {
      const row = await updateSubscription(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        id,
        ...parsed.data,
      });
      return row;
    } catch (err) {
      return renderErr(reply, err);
    }
  });

  app.delete("/v1/cantilapay/subscriptions/:id", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const q = (req.query ?? {}) as { at_period_end?: string };
    try {
      const row = await cancelSubscription(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        id,
        atPeriodEnd: q.at_period_end === "true",
      });
      return row;
    } catch (err) {
      return renderErr(reply, err);
    }
  });

  /* ----- Tenant API — Invoices (Phase 2) ----- */

  app.get("/v1/cantilapay/invoices/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getInvoice(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("invoice").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/invoices", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as {
      customer?: string;
      subscription?: string;
      status?: string;
      limit?: string;
    };
    const rows = await listInvoices(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      customerId: q.customer,
      subscriptionId: q.subscription,
      status: q.status as never,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { invoices: rows };
  });

  app.post("/v1/cantilapay/invoices/:id/void", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    try {
      const row = await voidInvoice(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        id,
      });
      return row;
    } catch (err) {
      return renderErr(reply, err);
    }
  });

  app.post("/v1/cantilapay/invoices/:id/mark_uncollectible", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    try {
      const row = await markInvoiceUncollectible(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        id,
      });
      return row;
    } catch (err) {
      return renderErr(reply, err);
    }
  });

  /* ----- Tenant API — Balance + Payouts (Phase 3) ----- */

  app.get("/v1/cantilapay/balance", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { currency?: string };
    const bal = await getBalance(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      currency: q.currency,
    });
    return bal;
  });

  app.get("/v1/cantilapay/balance_transactions", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { limit?: string };
    const rows = await listBalanceTransactions(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { balance_transactions: rows };
  });

  const createPayoutSchema = z.object({
    amount: z.number().int().positive().optional(),
    currency: z.string().regex(/^[a-z]{3}$/).optional(),
  });

  app.post("/v1/cantilapay/payouts", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = createPayoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      try {
        const row = await createPayout(prisma, {
          cantilapayAccountId: key.cantilapayAccountId,
          mode: key.mode,
          ...parsed.data,
        });
        return { status: 201, body: row };
      } catch (err) {
        if (err instanceof CantilapayError) {
          return { status: err.status, body: { error: err.body } as never };
        }
        throw err;
      }
    });
  });

  app.get("/v1/cantilapay/payouts/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getPayout(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("payout").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/payouts", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { status?: string; limit?: string };
    const rows = await listPayouts(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      status: q.status as never,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { payouts: rows };
  });

  /* ----- Tenant API — Checkout + Billing Portal Sessions (Phase 4) ----- */

  const paymentItemSchema = z.object({
    name: z.string().min(1).max(255),
    amount: z.number().int().positive(),
    currency: z.string().regex(/^[a-z]{3}$/),
    quantity: z.number().int().positive().optional(),
  });
  const subscriptionItemSchema = z.object({
    priceId: z.string().min(1),
    quantity: z.number().int().positive().optional(),
  });
  const createCheckoutSessionSchema = z.object({
    sessionMode: z.enum(["payment", "subscription", "setup"]),
    uiMode: z.enum(["hosted", "embedded"]).optional(),
    customerId: z.string().min(1).optional(),
    successUrl: z.string().url(),
    cancelUrl: z.string().url().optional(),
    returnUrl: z.string().url().optional(),
    currency: z.string().regex(/^[a-z]{3}$/),
    paymentItems: z.array(paymentItemSchema).optional(),
    subscriptionItems: z.array(subscriptionItemSchema).optional(),
    metadata: z.record(z.string().max(500)).optional(),
  });
  const completeCheckoutSessionSchema = z.object({
    paymentMethodId: z.string().min(1),
  });

  app.post("/v1/cantilapay/checkout/sessions", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = createCheckoutSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      try {
        const row = await createCheckoutSession(prisma, {
          cantilapayAccountId: key.cantilapayAccountId,
          mode: key.mode,
          ...parsed.data,
        });
        return { status: 201, body: row };
      } catch (err) {
        if (err instanceof CantilapayError) {
          return { status: err.status, body: { error: err.body } as never };
        }
        throw err;
      }
    });
  });

  app.get("/v1/cantilapay/checkout/sessions/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getCheckoutSession(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("checkout session").body });
    }
    return row;
  });

  app.get("/v1/cantilapay/checkout/sessions", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const q = (req.query ?? {}) as { status?: string; limit?: string };
    const rows = await listCheckoutSessions(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      status: q.status as never,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { checkout_sessions: rows };
  });

  app.post("/v1/cantilapay/checkout/sessions/:id/complete", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const parsed = completeCheckoutSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    try {
      const row = await completeCheckoutSession(prisma, selection.processor, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        id,
        paymentMethodId: parsed.data.paymentMethodId,
      });
      return row;
    } catch (err) {
      return renderErr(reply, err);
    }
  });

  const createBillingPortalSessionSchema = z.object({
    customerId: z.string().min(1),
    returnUrl: z.string().url().optional(),
  });

  app.post("/v1/cantilapay/billing_portal/sessions", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = createBillingPortalSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    try {
      const row = await createBillingPortalSession(prisma, {
        cantilapayAccountId: key.cantilapayAccountId,
        mode: key.mode,
        ...parsed.data,
      });
      return reply.code(201).send(row);
    } catch (err) {
      return renderErr(reply, err);
    }
  });

  app.get("/v1/cantilapay/billing_portal/sessions/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getBillingPortalSession(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("billing portal session").body });
    }
    return row;
  });

  /* ----- Tenant API — Tax (Phase 5) ----- */

  const calculateTaxSchema = z.object({
    amount: z.number().int().positive(),
    currency: z.string().regex(/^[a-z]{3}$/),
    customerCountry: z.string().min(2).max(3),
    customerState: z.string().max(40).optional(),
    customerPostalCode: z.string().max(20).optional(),
    productCategory: z.string().max(60).optional(),
  });

  app.post("/v1/cantilapay/tax/calculations", async (req, reply) => {
    const key = await requireCantilapaySecretKey(prisma, req, reply);
    if (!key) return;
    const parsed = calculateTaxSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: CantilapayError.invalidField(parsed.error.message).body });
    }
    await withIdem(req, reply, key.cantilapayAccountId, key.mode, async () => {
      try {
        const row = await calculateTax(prisma, taxSelection.provider, {
          cantilapayAccountId: key.cantilapayAccountId,
          mode: key.mode,
          ...parsed.data,
        });
        return { status: 201, body: row };
      } catch (err) {
        if (err instanceof CantilapayError) {
          return { status: err.status, body: { error: err.body } as never };
        }
        throw err;
      }
    });
  });

  app.get("/v1/cantilapay/tax/calculations/:id", async (req, reply) => {
    const key = await requireCantilapayAnyKey(prisma, req, reply);
    if (!key) return;
    const { id } = req.params as { id: string };
    const row = await getTaxCalculation(prisma, {
      cantilapayAccountId: key.cantilapayAccountId,
      mode: key.mode,
      id,
    });
    if (!row) {
      return reply.code(404).send({ error: CantilapayError.notFound("tax calculation").body });
    }
    return row;
  });

  /* ----- Inbound PSP webhook ----- */

  const inboundQuerySchema = z.object({
    mode: z.enum(["test", "live"]).default("test"),
  });

  app.post("/v1/cantilapay/webhooks/adyen", async (req, reply) => {
    const q = inboundQuerySchema.safeParse(req.query ?? {});
    if (!q.success) {
      return reply
        .code(400)
        .send({ error: CantilapayError.invalidField(q.error.message).body });
    }
    const rawBody = rawBodyOf(req);
    try {
      const outcome = await handleInboundWebhook({
        prisma,
        processor: selection.processor,
        rawBody,
        headers: req.headers as Record<string, string | string[] | undefined>,
        mode: q.data.mode as CantilapayMode,
      });
      return reply.code(200).send({
        accepted: outcome.accepted,
        eventId: outcome.eventId,
        type: outcome.type,
        processed: outcome.processed,
      });
    } catch (err) {
      if (err instanceof InboundSignatureError) {
        return reply.code(400).send({
          error: CantilapayError.invalidField(err.message, "signature").body,
        });
      }
      const msg = err instanceof Error ? err.message : "inbound webhook failed";
      // Phase 0: unhandled Adyen event types reach here. Adyen retries
      // on a non-2xx, so we'd loop on these forever. Return 200 with a
      // `skipped` flag so Adyen marks the notification as delivered.
      return reply.code(200).send({ accepted: false, skipped: true, reason: msg });
    }
  });
}

function rawBodyOf(req: FastifyRequest): string {
  return (req as unknown as { rawBody?: string }).rawBody ?? "";
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
