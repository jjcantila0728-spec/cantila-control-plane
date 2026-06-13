/* ============================================================
   Tests for the source-completeness gate. The motivating case is
   homepal (prj_ac50dd8ccf3349ae): a batched import dropped ~18 live
   `lib/*` modules but kept dead v1 cruft, so `next build` failed with
   "Module not found: @/lib/constants …" and the container crash-looped.
   The gate must catch exactly that BEFORE deploy.
   ============================================================ */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findMissingRefs,
  findMissingFromEntries,
  detectEntryPoints,
  parseAliases,
  parseViteAliases,
  mergeAliasPaths,
  extractSpecifiers,
  normalizePath,
  isSourcePath,
  type SourceFile,
} from "./source-completeness";

const NEXT_ALIASES = parseAliases(
  JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
);

test("flags an alias import whose target file was dropped (the homepal bug)", () => {
  const paths = ["components/auth/AuthCard.tsx", "lib/auth.ts"]; // lib/constants MISSING
  const sources: SourceFile[] = [
    { path: "components/auth/AuthCard.tsx", content: "import { APP } from '@/lib/constants';" },
  ];
  const missing = findMissingRefs(paths, sources, NEXT_ALIASES);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].specifier, "@/lib/constants");
  assert.equal(missing[0].importer, "components/auth/AuthCard.tsx");
});

test("resolves an alias import to an existing .ts file (no false positive)", () => {
  const paths = ["components/auth/AuthCard.tsx", "lib/constants.ts"];
  const sources: SourceFile[] = [
    { path: "components/auth/AuthCard.tsx", content: "import { APP } from '@/lib/constants';" },
  ];
  assert.deepEqual(findMissingRefs(paths, sources, NEXT_ALIASES), []);
});

test("resolves an alias import to a directory index file", () => {
  const paths = ["app/api/discover/route.ts", "lib/cctv/index.ts"];
  const sources: SourceFile[] = [
    { path: "app/api/discover/route.ts", content: "import { isCloud } from '@/lib/cctv';" },
  ];
  assert.deepEqual(findMissingRefs(paths, sources, NEXT_ALIASES), []);
});

test("resolves a relative import with extension inference", () => {
  const paths = ["instrumentation.ts", "lib/migrate.ts"];
  const sources: SourceFile[] = [
    { path: "instrumentation.ts", content: "const m = await import('./lib/migrate');" },
  ];
  assert.deepEqual(findMissingRefs(paths, sources, NEXT_ALIASES), []);
});

test("flags a relative dynamic import whose file is missing", () => {
  const paths = ["instrumentation.ts"]; // ./lib/migrate dropped
  const sources: SourceFile[] = [
    { path: "instrumentation.ts", content: "const m = await import('./lib/migrate');" },
  ];
  const missing = findMissingRefs(paths, sources, NEXT_ALIASES);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].specifier, "./lib/migrate");
});

test("resolves a parent-relative import across directories", () => {
  const paths = ["server/index.ts", "server/routes.ts", "shared/schema.ts"];
  const sources: SourceFile[] = [
    { path: "server/index.ts", content: "import { x } from '../shared/schema';" },
  ];
  assert.deepEqual(findMissingRefs(paths, sources, NEXT_ALIASES), []);
});

test("ignores bare npm + builtin + url specifiers", () => {
  const paths = ["app/api/discover/route.ts"];
  const sources: SourceFile[] = [
    {
      path: "app/api/discover/route.ts",
      content: [
        "import { NextResponse } from 'next/server';",
        "import React from 'react';",
        "import crypto from 'node:crypto';",
        "import x from 'https://esm.sh/x';",
      ].join("\n"),
    },
  ];
  assert.deepEqual(findMissingRefs(paths, sources, NEXT_ALIASES), []);
});

test("does not mistake Array.from / Buffer.from for an import", () => {
  const paths = ["lib/util.ts"];
  const sources: SourceFile[] = [
    { path: "lib/util.ts", content: "const a = Array.from(xs); const b = Buffer.from('aa','base64');" },
  ];
  assert.deepEqual(findMissingRefs(paths, sources, NEXT_ALIASES), []);
});

test("catches require() and side-effect imports too", () => {
  const paths = ["server/db.js"]; // both targets missing
  const sources: SourceFile[] = [
    { path: "server/db.js", content: "require('./missing-a');\nimport './missing-b';" },
  ];
  const missing = findMissingRefs(paths, sources, NEXT_ALIASES).map((m) => m.specifier).sort();
  assert.deepEqual(missing, ["./missing-a", "./missing-b"]);
});

test("handles multiline named imports (anchors on `from`)", () => {
  const paths = ["components/shell/AppShell.tsx"]; // @/lib/format missing
  const sources: SourceFile[] = [
    {
      path: "components/shell/AppShell.tsx",
      content: "import {\n  fmtMoney,\n  fmtDate,\n} from '@/lib/format';",
    },
  ];
  const missing = findMissingRefs(paths, sources, NEXT_ALIASES);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].specifier, "@/lib/format");
});

test("dedupes repeated missing specifier within one file", () => {
  const paths = ["a.ts"];
  const sources: SourceFile[] = [
    { path: "a.ts", content: "import x from './gone';\nconst y = require('./gone');" },
  ];
  assert.equal(findMissingRefs(paths, sources, NEXT_ALIASES).length, 1);
});

test("parseAliases tolerates comments and missing paths", () => {
  assert.deepEqual(parseAliases(undefined), { baseUrl: ".", paths: {} });
  const withComments = `{
    // tsconfig
    "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } }
  }`;
  const a = parseAliases(withComments);
  assert.deepEqual(a.paths, { "@/*": ["./*"] });
});

test("extractSpecifiers + helpers behave", () => {
  assert.deepEqual(
    extractSpecifiers("import a from 'x';\nexport { b } from 'y';").sort(),
    ["x", "y"],
  );
  assert.equal(normalizePath("./app/../lib/x"), "lib/x");
  assert.equal(isSourcePath("lib/x.tsx"), true);
  assert.equal(isSourcePath("db/migrations/0001_init.sql"), false);
});

test("entry-scoped scan ignores drops in code the build never reaches", () => {
  // `app/page.tsx` (reached) imports a present component; a dead
  // `client/src/legacy.ts` (NOT reached) imports a missing sibling.
  // The gate must flag nothing — the dead file can't break the build.
  const paths = ["app/page.tsx", "components/Home.tsx", "client/src/legacy.ts"];
  const sources: SourceFile[] = [
    { path: "app/page.tsx", content: "import Home from '@/components/Home';" },
    { path: "components/Home.tsx", content: "export default function Home(){return null}" },
    { path: "client/src/legacy.ts", content: "import './gone-but-dead';" },
  ];
  const entries = detectEntryPoints(paths, JSON.stringify({ dependencies: { next: "15" } }));
  assert.deepEqual(findMissingFromEntries(paths, sources, NEXT_ALIASES, entries), []);
  // whole-tree scan, by contrast, DOES see the dead drop:
  assert.equal(findMissingRefs(paths, sources, NEXT_ALIASES).length, 1);
});

test("entry-scoped scan flags a real drop reachable from app/", () => {
  const paths = ["app/page.tsx"]; // @/lib/state dropped
  const sources: SourceFile[] = [
    { path: "app/page.tsx", content: "import { store } from '@/lib/state';" },
  ];
  const entries = detectEntryPoints(paths, JSON.stringify({ dependencies: { next: "15" } }));
  const missing = findMissingFromEntries(paths, sources, NEXT_ALIASES, entries);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].specifier, "@/lib/state");
});

test("detectEntryPoints picks the Next app graph, not dead express/vite trees", () => {
  const paths = [
    "app/page.tsx",
    "app/layout.tsx",
    "instrumentation.ts",
    "next.config.mjs",
    "server/index.ts", // dead v1 express — must NOT be an entry for a Next app
    "client/src/main.tsx", // dead v1 vite — must NOT be an entry
  ];
  const entries = detectEntryPoints(paths, JSON.stringify({ dependencies: { next: "15.1.6" } }));
  assert.ok(entries.includes("app/page.tsx"));
  assert.ok(entries.includes("instrumentation.ts"));
  assert.ok(!entries.includes("server/index.ts"));
  assert.ok(!entries.includes("client/src/main.tsx"));
});

test("detectEntryPoints falls back to server entry for a non-Next node app", () => {
  const paths = ["server/index.ts", "server/routes.ts"];
  const entries = detectEntryPoints(paths, JSON.stringify({ dependencies: { express: "4" } }));
  assert.deepEqual(entries, ["server/index.ts"]);
});

test("detectEntryPoints last-resort scans everything when no entrypoint is recognised", () => {
  const paths = ["weird/thing.ts", "another/mod.ts"];
  const entries = detectEntryPoints(paths, undefined);
  assert.deepEqual(entries.sort(), ["another/mod.ts", "weird/thing.ts"]);
});

test("vite aliases merge so a client-root @ import is not falsely flagged", () => {
  // tsconfig maps @ -> repo root; vite maps @ -> client/src. A file under
  // client/src importing '@/pages/x' resolves to client/src/pages/x.
  const ts = parseAliases(JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }));
  const vite = parseViteAliases(
    'alias: { "@": path.resolve(import.meta.dirname, "client", "src") }',
  );
  const merged = mergeAliasPaths(ts.paths, vite);
  assert.deepEqual(merged["@/*"], ["./*", "client/src/*"]);
  const aliases = { baseUrl: ".", paths: merged };
  const paths = ["client/src/app.ts", "client/src/pages/x.tsx"];
  const sources: SourceFile[] = [
    { path: "client/src/app.ts", content: "import X from '@/pages/x';" },
  ];
  assert.deepEqual(findMissingRefs(paths, sources, aliases), []);
});

test("end-to-end: homepal-shaped tree with several dropped lib modules", () => {
  const paths = [
    "components/auth/AuthCard.tsx",
    "components/shell/AppShell.tsx",
    "instrumentation.ts",
    "lib/auth.ts", // present
    // dropped: lib/constants, lib/format, lib/selectors, lib/migrate
  ];
  const sources: SourceFile[] = [
    { path: "components/auth/AuthCard.tsx", content: "import { A } from '@/lib/constants';" },
    {
      path: "components/shell/AppShell.tsx",
      content: "import { f } from '@/lib/format';\nimport { s } from '@/lib/selectors';\nimport { A } from '@/lib/constants';",
    },
    { path: "instrumentation.ts", content: "await import('./lib/migrate');" },
  ];
  const missing = new Set(findMissingRefs(paths, sources, NEXT_ALIASES).map((m) => m.specifier));
  assert.deepEqual(
    [...missing].sort(),
    ["./lib/migrate", "@/lib/constants", "@/lib/format", "@/lib/selectors"],
  );
});
