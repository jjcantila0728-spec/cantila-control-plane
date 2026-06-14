/* One-shot: redeploy the Cantila control-plane's OWN Coolify app so the
   pushed deploy-pipeline fixes (commit c07b652) take effect. Scoped — it
   locates only the control-plane app (by api/mcp.cantila.app fqdn) and
   triggers its deploy. Reads creds from .env; prints no secrets. */
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const get = (k) => {
  const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
};
const URL_ = get("COOLIFY_API_URL");
const TOK = get("COOLIFY_API_TOKEN");
if (!URL_ || !TOK) throw new Error("missing COOLIFY_API_URL / COOLIFY_API_TOKEN");

const h = { Authorization: `Bearer ${TOK}`, Accept: "application/json" };

const apps = await fetch(`${URL_}/applications`, { headers: h }).then((r) => r.json());
if (!Array.isArray(apps)) throw new Error(`unexpected /applications: ${JSON.stringify(apps).slice(0, 160)}`);

const cp = apps.find((a) => /(^|\b)(api|mcp)\.cantila\.app/.test(a.fqdn || "")) ||
  apps.find((a) => /control[-_ ]?plane/i.test(a.name || ""));
if (!cp) {
  console.log("control-plane app NOT found among", apps.length, "apps");
  console.log("candidates:", apps.map((a) => a.name).join(", "));
  process.exit(2);
}
console.log(`control-plane app: ${cp.name} (${cp.uuid}) fqdn=${cp.fqdn}`);

const res = await fetch(`${URL_}/deploy?uuid=${encodeURIComponent(cp.uuid)}`, {
  method: "POST",
  headers: h,
});
const body = await res.json().catch(() => ({}));
console.log(`deploy POST → ${res.status}`);
const depUuid = body.deployment_uuid || body.deployments?.[0]?.deployment_uuid;
console.log("deployment_uuid:", depUuid || JSON.stringify(body).slice(0, 200));
