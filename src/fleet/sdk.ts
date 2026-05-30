import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** The subset of the SDK query signature we depend on. Injected so tests fake it. */
export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/** Lazily load the real SDK `query`. Returns null if the package can't be
 *  loaded (missing dep / incompatible env) so callers degrade gracefully. */
export function loadQuery(): QueryFn | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@anthropic-ai/claude-agent-sdk");
    return typeof mod.query === "function" ? (mod.query as QueryFn) : null;
  } catch {
    return null;
  }
}
