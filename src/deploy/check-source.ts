/* ============================================================
   Deploy-time source-completeness check (IO bridge).

   Pulls the project's repo as a single .zip archive (one call), unzips
   it in-memory, and runs the pure {@link findMissingFromEntries} gate so
   a deploy that would crash on a dropped file is refused BEFORE the build
   instead of after a confusing `exited:unhealthy` crash-loop.

   Kept thin and separately testable; all judgement lives in the pure
   `source-completeness` module.
   ============================================================ */
import { unzipSync, strFromU8 } from "fflate";
import {
  findMissingFromEntries,
  detectEntryPoints,
  parseAliases,
  parseViteAliases,
  mergeAliasPaths,
  isSourcePath,
  type MissingRef,
  type SourceFile,
} from "./source-completeness";

export interface CompletenessReport {
  missing: MissingRef[];
  entryCount: number;
  fileCount: number;
}

const CONFIG_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
]);

/** Gitea/GitHub zip archives nest everything under a single wrapper folder
 *  (e.g. `homepal/…` or `homepal-main/…`). Strip that common first segment
 *  so paths are repo-relative. */
function stripCommonTopDir(names: string[]): (name: string) => string {
  const tops = new Set<string>();
  for (const n of names) {
    const slash = n.indexOf("/");
    if (slash > 0) tops.add(n.slice(0, slash));
    else tops.add(""); // a top-level file → no common wrapper
  }
  if (tops.size === 1 && !tops.has("")) {
    return (name) => name.slice(name.indexOf("/") + 1);
  }
  return (name) => name;
}

/** Unzip a repo archive and report any build-reachable imports that point
 *  at files missing from the tree. */
export function checkArchiveCompleteness(archive: Uint8Array): CompletenessReport {
  const unz = unzipSync(archive);
  const rawNames = Object.keys(unz).filter((n) => !n.endsWith("/"));
  const strip = stripCommonTopDir(rawNames);

  const all: string[] = [];
  const textByPath = new Map<string, string>();
  for (const raw of rawNames) {
    const name = strip(raw);
    if (!name) continue;
    all.push(name);
    const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
    if (isSourcePath(name) || CONFIG_NAMES.has(base)) {
      try {
        textByPath.set(name, strFromU8(unz[raw]));
      } catch {
        /* binary/undecodable — not a source file we scan */
      }
    }
  }

  const sources: SourceFile[] = [];
  for (const [path, content] of textByPath) {
    if (isSourcePath(path)) sources.push({ path, content });
  }
  // Config files are read at repo root only (root-level keys have no slash
  // after the wrapper dir is stripped).
  const read = (name: string): string | undefined => textByPath.get(name);

  const ts = parseAliases(read("tsconfig.json") ?? read("jsconfig.json"));
  const viteText =
    read("vite.config.ts") ?? read("vite.config.js") ?? read("vite.config.mjs");
  const aliases = {
    baseUrl: ts.baseUrl,
    paths: mergeAliasPaths(ts.paths, parseViteAliases(viteText)),
  };
  const entries = detectEntryPoints(all, read("package.json"));
  const missing = findMissingFromEntries(all, sources, aliases, entries);
  return { missing, entryCount: entries.length, fileCount: all.length };
}

/** Format a blocking error message for a deploy that would ship an
 *  incomplete tree. */
export function formatIncompleteSourceError(report: CompletenessReport): string {
  const shown = report.missing.slice(0, 25);
  const lines = shown.map((m) => `  • ${m.importer} → ${m.specifier}`);
  const more =
    report.missing.length > shown.length
      ? `\n  …and ${report.missing.length - shown.length} more`
      : "";
  return (
    `source-incomplete: ${report.missing.length} import(s) reachable from the build ` +
    `entrypoints reference files that are missing from the repo. The source push ` +
    `dropped files — re-push the complete source, then redeploy.\n` +
    lines.join("\n") +
    more
  );
}
