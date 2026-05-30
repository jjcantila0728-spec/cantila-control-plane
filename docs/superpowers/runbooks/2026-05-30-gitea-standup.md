# Gitea Standup Runbook — Task 10 (Cantila-hosted git store)

Bring up a live Gitea at **git.cantila.app** and wire the control-plane to it,
flipping repoHost="cantila" projects from the in-memory stub to a durable git
backend. Steps are marked **[USER]** (needs console/credential access) or
**[AGENT]** (drivable once the API is reachable + creds provided).

Prereq context: the control-plane reads `GITEA_URL` + `GITEA_TOKEN` (see
`src/config.ts`). Until `GITEA_URL` is set, the production guard in
`ensureProjectRepo` keeps repo-less projects in the "no repo connected" state
(no stub writes in prod), so nothing breaks before this runbook is done.

---

## 1. [USER] DNS
Add a Namecheap record for the owned domain `cantila.app`:
- **Type A** · Host `git` · Value = the Hetzner host IP that Coolify runs on
  (the same IP the other Coolify apps resolve to — `168.119.97.112` per the
  local Coolify base URL).
Confirm: `nslookup git.cantila.app` resolves to that IP.

## 2. [USER] Create the Gitea resource in Coolify (UI is the reliable path)
In the Coolify dashboard → the Cantila project → **+ New Resource**:

Option A (simplest): **Services → Gitea** one-click template. Then in the
service settings set:
- Domain: `https://git.cantila.app` (Coolify provisions Let's Encrypt TLS).
- A persistent volume for `/data` (the template usually defines `gitea-data`).
- A Postgres database (the template includes one; otherwise add a Postgres
  resource and point Gitea at it).

Option B (explicit): **+ New Resource → Docker Compose**, paste this compose,
set the domain to `git.cantila.app`:
```yaml
services:
  gitea:
    image: gitea/gitea:1.22
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
      GITEA__database__DB_TYPE: postgres
      GITEA__database__HOST: db:5432
      GITEA__database__NAME: gitea
      GITEA__database__USER: gitea
      GITEA__database__PASSWD: ${GITEA_DB_PASSWORD}
      GITEA__server__DOMAIN: git.cantila.app
      GITEA__server__ROOT_URL: https://git.cantila.app/
      GITEA__server__SSH_DOMAIN: git.cantila.app
      GITEA__service__DISABLE_REGISTRATION: "true"
      GITEA__security__INSTALL_LOCK: "true"
    volumes:
      - gitea-data:/data
    ports:
      - "3000"
    depends_on:
      - db
    restart: unless-stopped
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: gitea
      POSTGRES_PASSWORD: ${GITEA_DB_PASSWORD}
      POSTGRES_DB: gitea
    volumes:
      - gitea-db:/var/lib/postgresql/data
    restart: unless-stopped
volumes:
  gitea-data:
  gitea-db:
```
Set `GITEA_DB_PASSWORD` to a strong value in the Coolify env for this resource.
Deploy and confirm the container is healthy and `https://git.cantila.app` serves
the Gitea UI.

## 3. [USER] Admin user + API token
- Because `DISABLE_REGISTRATION=true` + `INSTALL_LOCK=true`, create the first
  admin via the container shell:
  `gitea admin user create --admin --username cantila-admin --email ops@cantila.app --password '<strong>'`
  (Coolify → the Gitea resource → Terminal/Exec, or `docker exec`.)
- Log in at `https://git.cantila.app` → Settings → Applications → **Generate New
  Token** with scopes: `write:organization`, `write:repository`, `read:user`
  (admin scope if creating orgs for others). Copy the token once.

## 4. [AGENT] Wire control-plane env + redeploy
On the **control-plane** Coolify app, set:
- `GITEA_URL = https://git.cantila.app`
- `GITEA_TOKEN = <token from step 3>`
Then redeploy the control-plane. (Agent can drive via the Coolify env + deploy
API once the API endpoint/creds are confirmed reachable; otherwise [USER] sets
these two envs in the Coolify UI and redeploys.)

Verify after boot: the control-plane log shows it started; `config.giteaUrl` is
now non-empty so the production guard no longer applies and repoHost="cantila"
projects resolve to the real `CantilaGitProvider`.

## 5. [AGENT] Smoke test
Against prod, open a repo-less project's workspace file-tree (or call
`GET /v1/projects/:id/files` authenticated). Expect:
- a Gitea org `<account-handle>` and repo `<slug>` are auto-created
  (`auto_init` seeds `main` + README),
- the tree lists the repo,
- editing a file + Save commits (visible in the Gitea UI under that repo),
- a second open is idempotent (no duplicate repo).
Record the result. If the live Gitea JSON shapes differ from the adapter's
assumptions (`src/git/cantila-provider.ts` mappers), adjust `mapTree`/`mapContent`
or the endpoint paths and redeploy.

## 6. [USER] Backups
Configure a scheduled backup of the `gitea-data` + `gitea-db` volumes (Coolify
scheduled backup, or a cron `gitea dump`). Note retention (e.g. daily, 7-day).

---

## Notes / gotchas
- **Auth scheme:** Gitea uses `Authorization: token <TOKEN>` — already handled in
  `CantilaGitProvider`.
- **Org-per-account:** repos live under an org named by the account handle
  (`orgNameForAccount`); `createRepo` creates the org idempotently first.
- **Branch trees:** Gitea's `git/trees` needs a commit sha, so the adapter
  resolves the branch via `/branches/{branch}` first — already handled.
- **No prod stub:** the `ensureProjectRepo` guard means that until step 4 is
  done, prod safely shows "no repo connected" rather than ephemeral stub edits.
- Coolify API recon from the dev box returned 404/401 on `/api/v1/*` (likely a
  proxy/version/path nuance), so steps 2–3 are done in the Coolify UI; steps 4–5
  can be driven via API once the working endpoint/token is confirmed.
