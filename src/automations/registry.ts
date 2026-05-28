/* ============================================================
   Engine registry — one adapter per AutomationKind.

   The control plane builds this at boot and route handlers look
   adapters up by kind. The registry is the only place that knows
   which adapter is wired for a kind, so swapping the stub for the
   real `N8nEngineAdapter` later is a one-line change.
   ============================================================ */

import type { AutomationKind } from "../domain/types";
import type { AutomationEngineAdapter, EngineRegistry } from "./engine";
import { StubEngineAdapter } from "./engines/stub";
import { N8nEngineAdapter } from "./engines/n8n";
import { OpenClawEngineAdapter } from "./engines/openclaw";

export class DefaultEngineRegistry implements EngineRegistry {
  private adapters = new Map<AutomationKind, AutomationEngineAdapter>();
  /** Visible label per kind ("n8n@stub" / "n8n@live") for the
   *  `GET /v1/automations/info` endpoint and the Console badge. */
  readonly labels = new Map<AutomationKind, string>();

  constructor(entries: { adapter: AutomationEngineAdapter; label: string }[]) {
    for (const { adapter, label } of entries) {
      this.adapters.set(adapter.kind, adapter);
      this.labels.set(adapter.kind, label);
    }
  }

  get(kind: AutomationKind): AutomationEngineAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`no engine adapter for kind: ${kind}`);
    return adapter;
  }
}

/** Auto-select wiring (plan §4.10, Phase B):
 *   * `n8n` — if `N8N_BASE_URL` + `N8N_API_KEY` are set, use the real
 *     `N8nEngineAdapter` (the canvas writes against a real n8n
 *     container). Otherwise the deterministic `StubEngineAdapter`
 *     keeps the same routes serving with no engine running.
 *   * `openclaw` — Phase D will swap this; for now it stays on the
 *     stub.
 *
 *  Same auto-select shape as `StripeAdapter` / `MailProvider` /
 *  `TelephonyProvider`: env var presence picks the adapter, everything
 *  else uses the stub. The label is surfaced to the Console so an
 *  operator can see at a glance which engine is wired.
 */
export function buildDefaultRegistry(): DefaultEngineRegistry {
  const n8nBase = process.env.N8N_BASE_URL?.trim();
  const n8nKey = process.env.N8N_API_KEY?.trim();
  const n8n =
    n8nBase && n8nKey
      ? {
          adapter: new N8nEngineAdapter({ baseUrl: n8nBase, apiKey: n8nKey }),
          label: "n8n@live",
        }
      : {
          adapter: new StubEngineAdapter("n8n"),
          label: "n8n@stub",
        };
  const openClawBase = process.env.OPENCLAW_BASE_URL?.trim();
  const openClawKey = process.env.OPENCLAW_API_KEY?.trim();
  const openClaw =
    openClawBase && openClawKey
      ? {
          adapter: new OpenClawEngineAdapter({
            baseUrl: openClawBase,
            apiKey: openClawKey,
          }),
          label: "openclaw@live",
        }
      : {
          adapter: new StubEngineAdapter("openclaw"),
          label: "openclaw@stub",
        };
  return new DefaultEngineRegistry([n8n, openClaw]);
}
