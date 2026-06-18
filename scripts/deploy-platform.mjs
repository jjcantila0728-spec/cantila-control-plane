/* Redeploy the Cantila platform's OWN Coolify apps (control-plane + console)
   so pushed fixes take effect. Scoped by fqdn; reads creds from .env; prints
   no secrets. Returns the triggered deployment uuids for polling. */
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

const targets = [
  { label: "control-plane", re: /\b(api|mcp)\.cantila\.app/, nameRe: /control[-_ ]?plane/i },
  { label: "console", re: /\bconsole\.cantila\.app/, nameRe: /console/i },
];

for (const t of targets) {
  const app =
    apps.find((a) => t.re.test(a.fqdn || "")) ||
    apps.find((a) => t.nameRe.test(a.name || ""));
  if (!app) {
    console.log(`[${t.label}] NOT FOUND among ${apps.length} apps`);
    continue;
  }
  const res = await fetch(`${URL_}/deploy?uuid=${encodeURIComponent(app.uuid)}`, {
    method: "GET",
    headers: h,
  }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const dep =
    res?.deployments?.[0]?.deployment_uuid || res?.deployment_uuid || res?.message || JSON.stringify(res).slice(0, 120);
  console.log(`[${t.label}] ${app.name} (${app.uuid}) fqdn=${app.fqdn} -> ${dep}`);
}
