/* ============================================================
   Request-scoped context (plan §5.5).

   Carries per-request audit data — primarily the *actor* account
   id, which differs from the *target* account id whenever an
   agency parent is acting as a sub-account via X-Cantila-Act-As
   or a parent-scoped session.

   Built on Node's AsyncLocalStorage so call sites (especially the
   many `recordEvent(…)` calls scattered through the control
   plane) don't need to thread an explicit `actorAccountId`
   argument through every function. The HTTP layer wraps each
   route handler in `runWithRequestContext({…}, handler)` and the
   inner code reads via `getRequestContext()`.

   Production safety:
    - Outside an HTTP request (cron jobs, the brain ticker, the
      stdio MCP entry point), `getRequestContext()` returns
      `undefined`. Code paths that read it must tolerate that.
    - The context is per-async-task; concurrent requests do not
      share it. AsyncLocalStorage handles the async fan-out
      transparently.
   ============================================================ */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** The principal that actually drove this request. When the caller
   *  is impersonating (X-Cantila-Act-As, or a session scoped into a
   *  sub-account via parenthood), this is the caller's own account —
   *  the parent — not the act-as target. */
  actorAccountId?: string;
  /** The signed-in user (for session-driven requests). Optional —
   *  API-key requests have no associated user. */
  sessionUserId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given context as the per-request audit context.
 *  All downstream `getRequestContext()` calls in the async tree see
 *  this context. Use this for code blocks where the scope is the
 *  callback (e.g. the stdio MCP entry point, the brain ticker if we
 *  ever want per-tick attribution). */
export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return storage.run(ctx, fn);
}

/** Set the context for the *current* async chain — every async
 *  operation triggered by code after this call will see it via
 *  `getRequestContext()`. Use this from Fastify hooks: an `onRequest`
 *  hook returns and Fastify continues the request in the same async
 *  chain, so `enterWith` is the right tool to seed the context once
 *  per request without wrapping every route handler. Has no effect
 *  outside an async context (will throw at the Node level if called
 *  with no async parent — but every Fastify hook is inside one). */
export function setRequestContext(ctx: RequestContext): void {
  storage.enterWith(ctx);
}

/** Read the current request's context. Returns `undefined` outside a
 *  request (cron jobs, the brain, stdio MCP). Read-only — to update,
 *  start a new context with `runWithRequestContext`. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
