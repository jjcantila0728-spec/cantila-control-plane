/* ============================================================
   Tests for the deploy-time archive completeness bridge — builds a real
   .zip (wrapped in a top-level folder, as Gitea/GitHub archives are),
   then asserts the gate flags a dropped module reachable from the build
   and passes a complete tree.
   ============================================================ */
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { checkArchiveCompleteness, formatIncompleteSourceError } from "./check-source";

function makeZip(files: Record<string, string>, wrapDir = "homepal"): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[`${wrapDir}/${path}`] = strToU8(content);
  }
  return zipSync(entries);
}

const PKG_NEXT = JSON.stringify({ dependencies: { next: "15.1.6" }, scripts: { build: "next build" } });
const TSCONFIG = JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } });

test("flags a dropped module reachable from the Next build entrypoints", () => {
  const zip = makeZip({
    "package.json": PKG_NEXT,
    "tsconfig.json": TSCONFIG,
    "app/page.tsx": "import { store } from '@/lib/state';\nexport default function P(){return null}",
    "instrumentation.ts": "export async function register(){ await import('./lib/migrate'); }",
    "lib/auth.ts": "export const x = 1;",
    // dropped: lib/state, lib/migrate
  });
  const report = checkArchiveCompleteness(zip);
  const specs = report.missing.map((m) => m.specifier).sort();
  assert.deepEqual(specs, ["./lib/migrate", "@/lib/state"]);
  assert.match(formatIncompleteSourceError(report), /source-incomplete: 2 import/);
});

test("passes a complete Next tree (no false positive)", () => {
  const zip = makeZip({
    "package.json": PKG_NEXT,
    "tsconfig.json": TSCONFIG,
    "app/page.tsx": "import { store } from '@/lib/state';",
    "lib/state.ts": "export const store = {};",
  });
  const report = checkArchiveCompleteness(zip);
  assert.deepEqual(report.missing, []);
});

test("ignores drops in a dead tree the Next build never reaches", () => {
  const zip = makeZip({
    "package.json": PKG_NEXT,
    "tsconfig.json": TSCONFIG,
    "app/page.tsx": "export default function P(){return null}",
    "server/index.ts": "import './missing-legacy';", // dead v1, not a Next entry
  });
  const report = checkArchiveCompleteness(zip);
  assert.deepEqual(report.missing, []);
});

test("handles a branch-suffixed wrapper dir (homepal-main/…)", () => {
  const zip = makeZip(
    {
      "package.json": PKG_NEXT,
      "tsconfig.json": TSCONFIG,
      "app/page.tsx": "import x from '@/lib/gone';",
    },
    "homepal-main",
  );
  const report = checkArchiveCompleteness(zip);
  assert.equal(report.missing.length, 1);
  assert.equal(report.missing[0].specifier, "@/lib/gone");
});
