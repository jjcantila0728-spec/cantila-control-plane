/* ============================================================
   Mailcow REST admin adapter for the MailboxProvisioner port.

   Endpoints (Mailcow API v1):
     GET  /api/v1/get/domain/<domain>
     POST /api/v1/add/domain
     POST /api/v1/add/mailbox
     POST /api/v1/delete/mailbox
   Auth: header `X-API-Key`. The add/* endpoints return an array of
   { type: "success" | "danger" | "error", msg } result objects.

   Only instantiated when MAILCOW_URL + MAILCOW_API_KEY are set
   (see createMailboxProvisioner). Uses the global `fetch` (Node 20).
   ============================================================ */

import type { MailboxProvisioner, ProvisionResult } from "./provisioner";

export class MailcowMailboxProvisioner implements MailboxProvisioner {
  readonly label = "Mailcow";
  readonly live = true;
  private readonly base: string;
  private readonly apiKey: string;

  constructor(opts: { url: string; apiKey: string }) {
    this.base = opts.url.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base}/api/v1${path}`, {
        method,
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${text}` };
      // add/* endpoints return an array of result objects; a non-"success"
      // type means the operation was rejected.
      try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) {
          const bad = parsed.find(
            (r) =>
              typeof r === "object" &&
              r !== null &&
              "type" in r &&
              (r as { type: string }).type !== "success",
          );
          if (bad) return { ok: false, detail: JSON.stringify(bad) };
        }
      } catch {
        /* non-JSON success (e.g. get/domain HTML) — treat as ok */
      }
      return { ok: true, detail: text };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async ensureDomain(domain: string): Promise<ProvisionResult> {
    const got = await this.call(
      "GET",
      `/get/domain/${encodeURIComponent(domain)}`,
    );
    // A present domain returns an object containing "domain_name".
    if (got.ok && got.detail.includes(`"domain_name"`)) return { ok: true };
    const add = await this.call("POST", "/add/domain", {
      domain,
      active: "1",
      restart_sogo: "0",
    });
    if (add.ok) return { ok: true };
    // Re-adding an existing domain is a harmless "exists" rejection.
    if (add.detail.includes("exists")) return { ok: true };
    return { error: `ensureDomain failed: ${add.detail}` };
  }

  async createMailbox(input: {
    address: string;
    password: string;
    quotaMb: number;
    displayName?: string;
  }): Promise<ProvisionResult> {
    const [local, domain] = input.address.split("@");
    if (!local || !domain) {
      return { error: `invalid address: ${input.address}` };
    }
    const res = await this.call("POST", "/add/mailbox", {
      local_part: local,
      domain,
      name: input.displayName ?? local,
      password: input.password,
      password2: input.password,
      quota: String(input.quotaMb),
      active: "1",
    });
    return res.ok
      ? { ok: true }
      : { error: `createMailbox failed: ${res.detail}` };
  }

  async deleteMailbox(address: string): Promise<ProvisionResult> {
    const res = await this.call("POST", "/delete/mailbox", [address]);
    return res.ok
      ? { ok: true }
      : { error: `deleteMailbox failed: ${res.detail}` };
  }
}
