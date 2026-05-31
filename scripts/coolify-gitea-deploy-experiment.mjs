#!/usr/bin/env node
/* ============================================================
   One-shot diagnostic: can Coolify deploy a PRIVATE self-hosted
   Gitea repo via the deploy-key (SSH) flow?

   Background: createApp currently uses POST /applications/public,
   which strips the host of a self-hosted HTTPS URL
   (https://git.cantila.app/cantila/<slug>.git -> "cantila/<slug>.git")
   so the clone fails with "does not appear to be a git repository".
   Coolify's documented path for a private self-hosted repo is
   POST /applications/private-deploy-key with an SSH URL + a
   registered deploy key. This script proves that recipe end-to-end
   against a THROWAWAY test app so we can bake it into createApp.

   It does NOT touch the existing cantilahomes app/project.

   Run (PowerShell):
     $env:COOLIFY_API_TOKEN="..."; $env:GITEA_TOKEN="..."; node scripts/coolify-gitea-deploy-experiment.mjs
   Run (bash):
     COOLIFY_API_TOKEN=... GITEA_TOKEN=... node scripts/coolify-gitea-deploy-experiment.mjs

   Required env:
     COOLIFY_API_TOKEN   Coolify API token (Keys & Tokens)
     GITEA_TOKEN         Gitea token with repo + write:public_key scope
   Optional env (auto-detected from the API if omitted):
     COOLIFY_API_URL     default http://168.119.97.112:8000/api/v1
     GITEA_URL           default https://git.cantila.app
     COOLIFY_PROJECT_UUID, COOLIFY_SERVER_UUID
     TEST_REPO           Gitea repo to clone, default cantila/cantilahomes
   ============================================================ */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COOLIFY_API_URL = (process.env.COOLIFY_API_URL || "http://168.119.97.112:8000/api/v1").replace(/\/+$/, "");
const COOLIFY_API_TOKEN = process.env.COOLIFY_API_TOKEN;
const GITEA_URL = (process.env.GITEA_URL || "https://git.cantila.app").replace(/\/+$/, "");
const GITEA_TOKEN = process.env.GITEA_TOKEN;
const TEST_REPO = process.env.TEST_REPO || "cantila/cantilahomes"; // owner/name
if (!COOLIFY_API_TOKEN || !GITEA_TOKEN) {
  console.error("Set COOLIFY_API_TOKEN and GITEA_TOKEN in the environment first.");
  process.exit(2);
}
if (/[<>]/.test(GITEA_TOKEN) || /your.*token/i.test(GITEA_TOKEN) || /[<>]/.test(COOLIFY_API_TOKEN)) {
  console.error("A token still looks like placeholder text (contains < > or 'your token').");
  console.error("Paste your REAL Gitea token value — no angle brackets. Example:");
  console.error('  $env:GITEA_TOKEN = "abc123def456..."');
  process.exit(2);
}

const stamp = Math.random().toString(36).slice(2, 8);
const cf = async (m, p, b) => {
  const r = await fetch(`${COOLIFY_API_URL}${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${COOLIFY_API_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    body: b ? JSON.stringify(b) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  return { s: r.status, j, t };
};
const gt = async (m, p, b) => {
  const r = await fetch(`${GITEA_URL}/api/v1${p}`, {
    method: m,
    headers: { Authorization: `token ${GITEA_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    body: b ? JSON.stringify(b) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  return { s: r.status, j, t };
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const list = (x) => (Array.isArray(x) ? x : x?.data ?? []);

async function main() {
  // 0. Resolve project + server uuids.
  let projectUuid = process.env.COOLIFY_PROJECT_UUID;
  let serverUuid = process.env.COOLIFY_SERVER_UUID;
  if (!projectUuid) {
    const r = await cf("GET", "/projects");
    const projects = list(r.j);
    projectUuid = (projects.find((p) => /cantila/i.test(p.name)) ?? projects[0])?.uuid;
    console.log("auto project_uuid:", projectUuid, `(of ${projects.length})`);
  }
  if (!serverUuid) {
    const r = await cf("GET", "/servers");
    const servers = list(r.j);
    serverUuid = servers[0]?.uuid;
    console.log("auto server_uuid:", serverUuid, `(of ${servers.length})`);
  }
  if (!projectUuid || !serverUuid) {
    console.error("Could not resolve project/server uuid — set COOLIFY_PROJECT_UUID / COOLIFY_SERVER_UUID.");
    process.exit(1);
  }

  // 1. Generate an ed25519 keypair locally (used only to register the deploy key).
  const dir = mkdtempSync(join(tmpdir(), "cfkey-"));
  const keyPath = join(dir, "id");
  execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -C cantila-coolify-${stamp}`, { stdio: "ignore" });
  const priv = readFileSync(keyPath, "utf8");
  const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();

  // 2. Register the PRIVATE key in Coolify.
  let r = await cf("POST", "/security/keys", { name: `cantila-gitea-${stamp}`, private_key: priv });
  console.log("\n[1] Coolify register key:", r.s, r.t.slice(0, 200));
  const keyUuid = r.j?.uuid;
  if (!keyUuid) { console.error("FAILED to register key in Coolify."); process.exit(1); }

  // 3. Add the PUBLIC key to the Gitea repo as a read-only deploy key.
  r = await gt("POST", `/repos/${TEST_REPO}/keys`, { title: `coolify-${stamp}`, key: pub, read_only: true });
  console.log("[2] Gitea add deploy key:", r.s, r.t.slice(0, 200));
  if (r.s >= 300 && r.s !== 422) { console.error("FAILED to add Gitea deploy key."); }

  // 4. Create a throwaway app via the private-deploy-key endpoint (scp-style SSH URL — avoids ssh:// bug #3247).
  const sshUrl = `git@${GITEA_URL.replace(/^https?:\/\//, "")}:${TEST_REPO}.git`;
  const name = `cantila-dktest-${stamp}`;
  const fqdn = `https://${name}.cantila.app`;
  const body = {
    project_uuid: projectUuid,
    server_uuid: serverUuid,
    environment_name: "production",
    name,
    private_key_uuid: keyUuid,
    git_repository: sshUrl,
    git_branch: "main",
    build_pack: "nixpacks",
    ports_exposes: "3000",
    domains: fqdn,
    instant_deploy: true,
  };
  console.log("\n[3] Create app via /applications/private-deploy-key");
  console.log("    git_repository =", sshUrl);
  r = await cf("POST", "/applications/private-deploy-key", body);
  console.log("    ->", r.s, r.t.slice(0, 400));
  const appUuid = r.j?.uuid;
  if (!appUuid) { console.error("FAILED to create app. Stop here and paste the output above."); cleanup(dir); process.exit(1); }

  // 5. Confirm Coolify stored the FULL SSH URL (not a stripped path).
  r = await cf("GET", `/applications/${appUuid}`);
  console.log("\n[4] Stored git_repository =", JSON.stringify(r.j?.git_repository), " git_branch =", JSON.stringify(r.j?.git_branch));

  // 4b. Explicitly trigger a deploy — don't rely on instant_deploy.
  const trig = await cf("GET", `/deploy?uuid=${encodeURIComponent(appUuid)}`);
  console.log("[4b] Trigger deploy ->", trig.s, trig.t.slice(0, 200));

  // 6. Poll the deployment log (~2.5 min) and print whether the CLONE step passed.
  console.log("\n[5] Waiting for build… (polling deployment log)");
  let logTail = "";
  for (let i = 0; i < 9; i++) {
    await sleep(18000);
    const d = await cf("GET", `/deployments/applications/${appUuid}`);
    const dep = list(d.j)[0];
    if (!dep) { console.log(`  poll ${i + 1}: no deployment yet`); continue; }
    let logs = dep.logs;
    try { logs = JSON.parse(dep.logs).map((l) => l.output ?? l).join("\n"); } catch {}
    logTail = String(logs || "");
    console.log(`  poll ${i + 1}: status=${dep.status}`);
    if (["finished", "failed", "error", "cancelled-by-force"].includes(String(dep.status))) break;
  }

  console.log("\n=== DEPLOY LOG (tail) ===");
  console.log(logTail.slice(-3000));
  const cloneFail = /does not appear to be a git repository|Could not read from remote|Permission denied \(publickey\)|fatal:/i.test(logTail);
  const cloneOk = /Cloning into|Nixpacks|Generating|docker build|Pulling|Building image|build (started|completed)/i.test(logTail);
  console.log("\n=== VERDICT ===");
  if (!logTail.trim()) {
    console.log("⚠️  INCONCLUSIVE — no deployment log appeared. The deploy didn't run, or the Gitea deploy key wasn't added (check [2] — it must be 201/Created). NOT a success.");
  } else if (cloneFail) {
    console.log("❌ Clone failed — see log above (publickey = SSH/key problem; not-a-repo = URL problem).");
  } else if (cloneOk) {
    console.log("✅ CLONE SUCCEEDED via deploy-key SSH — recipe confirmed.");
  } else {
    console.log("⚠️  INCONCLUSIVE — log present but no clear clone marker; read the log above.");
  }
  console.log(`Test app uuid: ${appUuid} (delete from Coolify when done).`);
  console.log(`Coolify key uuid: ${keyUuid} ; Gitea deploy key on ${TEST_REPO}.`);
  cleanup(dir);
}
function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
main().catch((e) => { console.error("ERROR:", e?.message || e); process.exit(1); });
