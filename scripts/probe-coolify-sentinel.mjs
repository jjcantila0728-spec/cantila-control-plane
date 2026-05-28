#!/usr/bin/env node
/* ============================================================
   Probe candidate Coolify Sentinel endpoints (plan §19.7 — D).

   Coolify's internal "Sentinel" agent collects per-container CPU /
   memory and surfaces them in the dashboard UI, but as of 2026-05-28
   the public REST API does not expose those series — both
   `/applications/<uuid>/metrics` and `/servers/<uuid>/metrics`
   return 404. This script probes a list of plausible paths against
   the live panel so the operator can spot any newly-exposed endpoint
   without writing throwaway curl loops.

   Usage:
     node scripts/probe-coolify-sentinel.mjs
   Reads COOLIFY_API_URL, COOLIFY_API_TOKEN, COOLIFY_SERVER_UUID,
   COOLIFY_PROJECT_UUID from `.env` (when present) or process.env.

   Output: one line per probe — `<status>  <method> <path>`. Non-404
   responses get a body preview so the operator can decide whether to
   wire it into `CoolifySentinelCollector` (`src/dataplane/
   coolify-sentinel.ts`).
   ============================================================ */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotenv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotenv(resolve(process.cwd(), ".env"));

const apiUrl = (process.env.COOLIFY_API_URL ?? "").replace(/\/+$/, "");
const token = process.env.COOLIFY_API_TOKEN;
const serverUuid = process.env.COOLIFY_SERVER_UUID;
const projectUuid = process.env.COOLIFY_PROJECT_UUID;

if (!apiUrl || !token) {
  console.error("missing COOLIFY_API_URL / COOLIFY_API_TOKEN — populate .env first");
  process.exit(1);
}

// Probe set: every plausible path Coolify *might* mount Sentinel
// data on, based on its public source naming (sentinel, metrics,
// telemetry, stats). Adjust this list as the Coolify changelog adds
// new shapes — the probe is meant to be edited.
const probes = [
  "GET /sentinel",
  "GET /sentinel/health",
  "GET /sentinel/version",
  `GET /servers/${serverUuid}/sentinel`,
  `GET /servers/${serverUuid}/sentinel/metrics`,
  `GET /servers/${serverUuid}/metrics-history`,
  `GET /servers/${serverUuid}/telemetry`,
  `GET /servers/${serverUuid}/stats`,
  `GET /servers/${serverUuid}/resources`,
  `GET /applications/sentinel`,
  `GET /applications/${projectUuid}/metrics-history`,
  "GET /metrics",
  "GET /telemetry",
];

const PREVIEW_BYTES = 240;

(async () => {
  for (const probe of probes) {
    const [method, path] = probe.split(" ");
    let line = `???  ${method} ${path}`;
    try {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5_000),
      });
      const body = await res.text().catch(() => "");
      const preview = body.length > 0
        ? `  ${body.slice(0, PREVIEW_BYTES).replace(/\s+/g, " ")}`
        : "";
      line = `${res.status}  ${method} ${path}${res.status !== 404 ? preview : ""}`;
    } catch (e) {
      line = `ERR  ${method} ${path}  ${e instanceof Error ? e.message : String(e)}`;
    }
    console.log(line);
  }
})();
