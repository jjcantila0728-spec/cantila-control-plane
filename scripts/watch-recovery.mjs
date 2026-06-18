/* Watch platform recovery after a deploy: poll Coolify deployment statuses
   and the live api/console edges until terminal/healthy or timeout. Prints a
   compact timeline; no secrets. */
import { readFileSync } from "node:fs";
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const URL_ = get("COOLIFY_API_URL");
const TOK = get("COOLIFY_API_TOKEN");
const h = { Authorization: `Bearer ${TOK}`, Accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deps = { cp: "obcyx2chr817ccbvlm0m9who", console: "l1od27f6axxf08ivejuut15u" };

async function code(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.status;
  } catch { return 0; }
}
async function depStatus(uuid) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const r = await fetch(`${URL_}/deployments/${uuid}`, { headers: h, signal: c.signal });
    clearTimeout(t);
    const j = await r.json();
    return (j.status || "").toLowerCase() || "?";
  } catch { return "(unreach)"; }
}

for (let i = 0; i < 20; i++) {
  const [cp, co] = await Promise.all([depStatus(deps.cp), depStatus(deps.console)]);
  const [api, con] = await Promise.all([
    code("https://api.cantila.app/api/cantila/v1/health"),
    code("https://console.cantila.app"),
  ]);
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${i}] ${ts} deploy(cp=${cp} console=${co}) edge(api=${api} console=${con})`);
  const apiHealthy = api === 200 || api === 401;
  const conHealthy = con === 200 || con === 307;
  if (apiHealthy && conHealthy) { console.log("RECOVERED: both edges healthy"); break; }
  await sleep(30000);
}
console.log("watch-recovery done");
