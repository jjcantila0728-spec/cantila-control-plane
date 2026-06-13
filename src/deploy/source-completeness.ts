/* ============================================================
   Source-completeness gate.

   A batched / multi-call source import (e.g. `cantila_push_files`
   driven by an agent, or a bootstrap clone) can leave a project's
   git repo MISSING whole files while still looking deployable —
   nothing downstream notices until the Coolify build fails with a
   "Module not found" and the container crash-loops (`exited:unhealthy`).
   That failure was silent and badly surfaced: the deploy looked like
   it shipped, and the build-log tail buried the real error under
   generic env-var warnings.

   This module statically resolves a repo's LOCAL import graph
   (relative + tsconfig-alias specifiers) against the files actually
   present in the repo. Any specifier that should resolve to an
   in-repo file but does not is a dropped file. The deploy pipeline
   runs this BEFORE building and refuses to ship an incomplete tree,
   turning a silent crash into a precise "these files are missing"
   error the deploying agent (or owner) can act on.

   Pure + IO-free so it is fully unit-testable. Bare specifiers
   (npm packages, `node:` builtins, urls) are intentionally ignored —
   we only judge files the repo is supposed to contain itself.
   ============================================================ */

export interface SourceFile {
  path: string;
  content: string;
}

export interface MissingRef {
  /** Repo-relative path of the file that imports the missing module. */
  importer: string;
  /** The unresolved import specifier as written (e.g. "@/lib/constants"). */
  specifier: string;
}

export interface Aliases {
  /** tsconfig `baseUrl`, repo-relative and normalised (defaults to "."). */
  baseUrl: string;
  /** tsconfig `compilerOptions.paths`, e.g. { "@/*": ["./*"] }. */
  paths: Record<string, string[]>;
}

/** Extensions whose files we scan for imports. */
const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Suffixes tried when resolving a bare (extensionless) specifier to a file. */
const RESOLVE_SUFFIX = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".svg",
  ".md",
  ".mdx",
  // directory index files
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
  "/index.cjs",
];

export function isSourcePath(p: string): boolean {
  const lower = p.toLowerCase();
  return SOURCE_EXT.some((e) => lower.endsWith(e));
}

/** Normalise a repo-relative path: drop "./", collapse "../", strip leading "/". */
export function normalizePath(p: string): string {
  const segments: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return segments.join("/");
}

/** Strip // line and /* *​/ block comments so a commented JSON tsconfig parses. */
function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n\r]*/g, "$1");
}

/** Parse tsconfig text into a baseUrl + paths alias map. Tolerant of
 *  comments and parse failure (returns the conventional `@/* -> ./*`
 *  default only when explicitly present; otherwise empty). */
export function parseAliases(tsconfigText: string | undefined): Aliases {
  const empty: Aliases = { baseUrl: ".", paths: {} };
  if (!tsconfigText) return empty;
  let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    parsed = JSON.parse(tsconfigText);
  } catch {
    try {
      parsed = JSON.parse(stripJsonComments(tsconfigText));
    } catch {
      return empty;
    }
  }
  const co = parsed.compilerOptions ?? {};
  return {
    baseUrl: normalizePath(co.baseUrl ?? ".") || ".",
    paths: co.paths ?? {},
  };
}

/** Vite/jsconfig add ALTERNATE roots for the same alias key (e.g. a Vite
 *  client sets `@` -> client/src while the root tsconfig sets `@` -> repo
 *  root). Resolving against EVERY configured root is what keeps the gate
 *  from false-flagging a file that exists under a different toolchain's
 *  alias root. This parses the common `"@": path.resolve(dirname, "a","b")`
 *  Vite alias form into extra `paths` targets and unions them in. */
export function parseViteAliases(viteText: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!viteText) return out;
  const entryRe = /["'](@[\w-]*)["']\s*:\s*path\.resolve\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(viteText)) !== null) {
    const key = m[1];
    const segs = [...m[2].matchAll(/["']([^"']+)["']/g)].map((s) => s[1]);
    const root = normalizePath(segs.join("/"));
    if (!root) continue;
    addTarget(out, `${key}/*`, `${root}/*`);
    addTarget(out, key, root);
  }
  return out;
}

function addTarget(map: Record<string, string[]>, key: string, target: string): void {
  const list = (map[key] ??= []);
  if (!list.includes(target)) list.push(target);
}

/** Union two `paths` maps so a key resolves against every configured root. */
export function mergeAliasPaths(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(a)) out[k] = [...v];
  for (const [k, v] of Object.entries(b)) for (const t of v) addTarget(out, k, t);
  return out;
}

const FROM_RE = /\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Extract every import/require/dynamic-import specifier from a source file. */
export function extractSpecifiers(content: string): string[] {
  const out = new Set<string>();
  for (const re of [FROM_RE, BARE_IMPORT_RE, REQUIRE_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.add(m[1]);
  }
  return [...out];
}

/** True when a specifier is something the repo itself should contain
 *  (relative or matches a configured alias) rather than an external
 *  package / builtin / url. */
function isLocal(spec: string, aliases: Aliases): boolean {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    return true;
  }
  return Object.keys(aliases.paths).some((key) => aliasMatch(key, spec) !== null);
}

/** If `key` (e.g. "@/*" or "@app") matches `spec`, return the wildcard
 *  capture (or "" for an exact key). Otherwise null. */
function aliasMatch(key: string, spec: string): string | null {
  const star = key.indexOf("*");
  if (star === -1) return spec === key ? "" : null;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return null;
  if (spec.length < prefix.length + suffix.length) return null;
  return spec.slice(prefix.length, spec.length - suffix.length);
}

/** Candidate repo-relative base paths a specifier could resolve to. */
function candidateBases(spec: string, importer: string, aliases: Aliases): string[] {
  const bases: string[] = [];
  if (spec.startsWith(".")) {
    const dir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
    bases.push(normalizePath(`${dir}/${spec}`));
  } else {
    for (const [key, targets] of Object.entries(aliases.paths)) {
      const captured = aliasMatch(key, spec);
      if (captured === null) continue;
      for (const target of targets) {
        const sub = target.replace("*", captured);
        bases.push(normalizePath(`${aliases.baseUrl}/${sub}`));
      }
    }
  }
  return bases;
}

function resolves(base: string, pathSet: Set<string>): boolean {
  if (!base) return true; // resolved to repo root — don't flag
  return RESOLVE_SUFFIX.some((suffix) => pathSet.has(normalizePath(base + suffix)));
}

/** Resolve a local specifier to the concrete repo file it points at (the
 *  first matching suffix candidate), or null if nothing exists. */
function resolveToFile(
  spec: string,
  importer: string,
  aliases: Aliases,
  pathSet: Set<string>,
): string | null {
  for (const base of candidateBases(spec, importer, aliases)) {
    if (!base) return importer; // resolves to repo root area — treat as present
    for (const suffix of RESOLVE_SUFFIX) {
      const cand = normalizePath(base + suffix);
      if (pathSet.has(cand)) return cand;
    }
  }
  return null;
}

function isExternal(spec: string): boolean {
  return spec.startsWith("node:") || /^[a-z][a-z0-9+.-]*:\/\//i.test(spec);
}

/** Resolve every local import in EVERY source file against `allPaths`.
 *  Whole-tree scan — flags drops anywhere, including in code the production
 *  build never compiles. Use {@link findMissingFromEntries} for a deploy
 *  gate so dead/unbuilt trees don't cause false blocks. */
export function findMissingRefs(
  allPaths: string[],
  sources: SourceFile[],
  aliases: Aliases,
): MissingRef[] {
  const pathSet = new Set(allPaths.map(normalizePath));
  const missing: MissingRef[] = [];
  const seen = new Set<string>();
  for (const file of sources) {
    const importer = normalizePath(file.path);
    for (const spec of extractSpecifiers(file.content)) {
      const clean = spec.split("?")[0].split("#")[0];
      if (isExternal(clean) || !isLocal(clean, aliases)) continue;
      if (candidateBases(clean, importer, aliases).length === 0) continue;
      if (resolveToFile(clean, importer, aliases, pathSet)) continue;
      const dedupeKey = `${importer}::${clean}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      missing.push({ importer, specifier: clean });
    }
  }
  return missing;
}

/** Reachability-scoped scan: walk the import graph starting from `entries`
 *  and only flag local imports that are actually reached from a real build
 *  entrypoint. This is what a deploy gate wants — a dropped file the build
 *  never imports cannot break the build, and flagging it would falsely block
 *  a good deploy (e.g. holes in a repo's dead pre-rewrite tree). */
export function findMissingFromEntries(
  allPaths: string[],
  sources: SourceFile[],
  aliases: Aliases,
  entries: string[],
): MissingRef[] {
  const pathSet = new Set(allPaths.map(normalizePath));
  const contentByPath = new Map(sources.map((s) => [normalizePath(s.path), s.content]));
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const e of entries) {
    const n = normalizePath(e);
    if (contentByPath.has(n) && !visited.has(n)) {
      visited.add(n);
      queue.push(n);
    }
  }
  const missing: MissingRef[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const importer = queue.shift()!;
    const content = contentByPath.get(importer)!;
    for (const spec of extractSpecifiers(content)) {
      const clean = spec.split("?")[0].split("#")[0];
      if (isExternal(clean) || !isLocal(clean, aliases)) continue;
      if (candidateBases(clean, importer, aliases).length === 0) continue;
      const target = resolveToFile(clean, importer, aliases, pathSet);
      if (!target) {
        const dedupeKey = `${importer}::${clean}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          missing.push({ importer, specifier: clean });
        }
        continue;
      }
      if (contentByPath.has(target) && !visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
    }
  }
  return missing;
}

/** Conventional production entrypoints present in the repo, chosen by the
 *  project's framework (read from package.json) so we seed the graph the
 *  deploy actually builds — not a dead sibling toolchain. */
export function detectEntryPoints(allPaths: string[], packageJsonText: string | undefined): string[] {
  const norm = allPaths.map(normalizePath);
  const isSrc = (p: string) => isSourcePath(p);
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
  try {
    if (packageJsonText) pkg = JSON.parse(packageJsonText);
  } catch {
    /* ignore */
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const buildScript = pkg.scripts?.build ?? "";
  const startScript = pkg.scripts?.start ?? "";
  const isNext = "next" in deps || /\bnext\b/.test(buildScript) || /\bnext\b/.test(startScript);

  const pick = (patterns: RegExp[]): string[] =>
    norm.filter((p) => isSrc(p) && patterns.some((re) => re.test(p)));

  if (isNext) {
    const entries = pick([
      /^app\//,
      /^src\/app\//,
      /^pages\//,
      /^src\/pages\//,
      /^instrumentation\./,
      /^middleware\./,
      /^src\/middleware\./,
      /^next\.config\./,
    ]);
    if (entries.length > 0) return entries;
  }

  // Generic Node/Vite/Express fallbacks.
  const generic = pick([
    /^server\/(index|main|app|server)\./,
    /^src\/(index|main)\./,
    /^src\/server\//,
    /^(index|main|server)\./,
    /^app\.[cm]?[jt]s$/,
  ]);
  if (generic.length > 0) return generic;

  // Last resort: no recognisable entrypoint — scan everything so we never
  // silently skip the check (whole-tree behaviour).
  return norm.filter(isSrc);
}
