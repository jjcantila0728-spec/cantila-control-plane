/* Poll a Coolify deployment to a terminal state, then health-check the
   control-plane. Usage: node scripts/poll-deploy.mjs <deployment_uuid> */
import { readFileSync } from "node:fs";
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const URL_ = get("COOLIFY_API_URL");
const TOK = get("COOLIFY_API_TOKEN");
const dep = process.argv[2];
const h = { Authorization: `Bearer ${TOK}`, Accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let status = "?";
for (let i = 0; i < 30; i++) {
  const d = await fetch(`${URL_}/deployments/${dep}`, { headers: h }).then((r) => r.json()).catch(() => ({}));
  status = (d.status || "").toLowerCase();
  console.log(`[${i}] status=${status || "(none)"}`);
  if (status === "finished" || status === "failed" || status === "cancelled") break;
  await sleep(10000);
}
console.log("FINAL deploy status:", status);

// Health check the control-plane
for (const path of ["/api/cantila/v1/health", "/api/health"]) {
  try {
    const r = await fetch(`https://api.cantila.app${path}`, { signal: AbortSignal.timeout(8000) });
    console.log(`health ${path} → ${r.status}`);
    if (r.ok) break;
  } catch (e) {
    console.log(`health ${path} → ERR ${e.name}`);
  }
}
