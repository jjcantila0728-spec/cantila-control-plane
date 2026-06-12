# Mobile Builds + Store Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cantila builds Android apps (iOS coming-soon) from project source and publishes them to Google Play under Cantila's Play Console account, with App Store wiring ready for when the Apple account exists.

**Architecture:** Env-gated port/adapter pattern (stub default, live behind env), additive to the existing web deploy pipeline. New `src/mobile/` module in cantila-control-plane (build provider, keystore, store publishers, routes), new `MobileBuild` + `StoreRelease` tables via boot-migrations, MCP tools, and a console "Mobile" ops tab.

**Tech Stack:** TypeScript/Fastify/Prisma (control-plane), node:test via tsx (`npm test`), Next.js/Tailwind (console). Google Play via androidpublisher v3 REST + RS256 JWT signed with `node:crypto` (no googleapis dep).

**Spec:** `docs/superpowers/specs/2026-06-11-mobile-builds-store-publish-design.md`

---

### Task 1: Mobile stack detection

**Files:**
- Modify: `src/git/detect-stack.ts` (append)
- Test: `src/git/detect-mobile-stack.test.ts`

- [ ] Write failing tests: `detectMobileStack(paths, read?)` returns
  - `{ mobileStack: "expo", label: "Expo (React Native)" }` for `package.json` with `expo` dep
  - `react-native` for `react-native` dep without `expo`
  - `flutter` for root `pubspec.yaml` whose content has `flutter:`
  - `capacitor` for `@capacitor/core` dep or root `capacitor.config.ts|json`
  - `android-native` for `android/build.gradle`(.kts) or root `build.gradle` + any `AndroidManifest.xml`
  - `null` for a plain Next.js repo
- [ ] Run `npm test -- src/git/detect-mobile-stack.test.ts` → FAIL (function missing)
- [ ] Implement:

```ts
export type MobileStack = "expo" | "react-native" | "flutter" | "capacitor" | "android-native";
export interface MobileStackInfo { mobileStack: MobileStack; label: string; }
export async function detectMobileStack(paths: string[], read?: FileReader): Promise<MobileStackInfo | null>
```

Precedence: expo → react-native → flutter → capacitor → android-native. Pure, reuses `FileReader`.
- [ ] Tests pass; commit `feat(mobile): detect mobile app stacks`

### Task 2: Data model

**Files:**
- Modify: `src/domain/types.ts` (MobileBuild, StoreRelease interfaces + Project fields `mobileStack?`, `androidApplicationId?`, `androidKeystore?`, `androidKeystoreSecret?`)
- Modify: `src/domain/store.ts` (interface methods + InMemoryStore impl)
- Modify: `src/domain/prisma-store.ts` (PrismaStore impl)
- Modify: `prisma/schema.prisma` (models + Project columns)
- Modify: `src/domain/boot-migrations.ts` (CREATE TABLE IF NOT EXISTS ×2, ALTER TABLE Project ×4)

Store methods:

```ts
createMobileBuild(b: MobileBuild): Promise<MobileBuild>;
getMobileBuild(id: string): Promise<MobileBuild | null>;
updateMobileBuild(id: string, patch: Partial<MobileBuild>): Promise<MobileBuild>;
listMobileBuilds(projectId: string): Promise<MobileBuild[]>;        // newest first
createStoreRelease(r: StoreRelease): Promise<StoreRelease>;
updateStoreRelease(id: string, patch: Partial<StoreRelease>): Promise<StoreRelease>;
listStoreReleases(projectId: string): Promise<StoreRelease[]>;     // newest first
```

MobileBuild: id, projectId, platform ("android"|"ios"), mobileStack, status ("queued"|"building"|"succeeded"|"failed"), artifactKind ("aab"|"apk"), artifactPath?, artifactSize?, applicationId, versionCode (int), versionName, log?, error?, createdAt, finishedAt?.
StoreRelease: id, projectId, buildId, store ("google_play"|"app_store"), track, status ("submitted"|"published"|"stubbed"|"failed"), externalRef?, error?, createdAt, updatedAt.

- [ ] Add types + store methods + both impls + prisma models
- [ ] boot-migrations: `20260611000000_create_mobile_build`, `20260611000001_create_store_release`, `20260611000002..5_add_project_mobile_columns` (all IF NOT EXISTS)
- [ ] `npx prisma generate` + `npm run typecheck` green; commit `feat(mobile): MobileBuild/StoreRelease data model`

### Task 3: Keystore helper

**Files:**
- Create: `src/mobile/keystore.ts`
- Test: `src/mobile/keystore.test.ts`

```ts
export interface KeystoreMaterial { keystoreB64: string; storePassword: string; keyPassword: string; alias: string; generated: boolean; }
export function defaultApplicationId(slug: string): string;            // app.cantila.<slug sanitized to [a-z0-9_] segments>
export async function ensureKeystore(project: Project, store: Store): Promise<KeystoreMaterial>;
```

`ensureKeystore`: decrypt + return existing; else try `keytool -genkeypair` into a temp file (RSA 2048, validity 10950, alias `cantila`, random passwords via `randomBytes`), fall back to a deterministic placeholder (generated:false) when keytool is unavailable; persist via `updateProject` with `encryptSecret`.

- [ ] Tests: defaultApplicationId sanitization; round-trip persistence (InMemoryStore + CANTILA_SECRET_KEY set); second call returns same material without regenerating
- [ ] Commit `feat(mobile): per-project android keystore management`

### Task 4: MobileBuildProvider

**Files:**
- Create: `src/mobile/build-provider.ts`
- Test: `src/mobile/build-provider.test.ts`

```ts
export interface AndroidBuildInput { projectId: string; workDir: string; mobileStack: MobileStack; applicationId: string; versionCode: number; versionName: string; artifactKind: "aab" | "apk"; keystore: KeystoreMaterial; outDir: string; }
export interface AndroidBuildResult { artifactPath: string; sizeBytes: number; log: string; }
export class IosBuildUnavailableError extends Error {}
export interface MobileBuildProvider { label: string; live: boolean; buildAndroid(i: AndroidBuildInput): Promise<AndroidBuildResult>; buildIos(): never; }
export class StubMobileBuildProvider implements MobileBuildProvider {}
export class DockerMobileBuildProvider implements MobileBuildProvider {}   // MOBILE_BUILDER=docker
export function createMobileBuildProvider(env: NodeJS.ProcessEnv): MobileBuildProvider;
```

Stub writes `<outDir>/<projectId>-<versionCode>.<kind>` with deterministic placeholder bytes (`CANTILA-STUB-AAB v<versionCode>`). Docker provider maps stack→image+command per spec §2 and shells out via `execFile("docker", ...)`; unit tests only cover command construction (exported `dockerBuildPlan(input)` pure helper), not real docker.

- [ ] Tests: factory returns stub by default / docker when `MOBILE_BUILDER=docker`; stub writes artifact + size>0; `buildIos` throws IosBuildUnavailableError; `dockerBuildPlan` per stack
- [ ] Commit `feat(mobile): mobile build provider (stub + docker)`

### Task 5: Store publishers

**Files:**
- Create: `src/mobile/store-publisher.ts`
- Test: `src/mobile/store-publisher.test.ts`

```ts
export type StoreKind = "google_play" | "app_store";
export interface PublishInput { applicationId: string; artifactPath: string; artifactKind: "aab" | "apk"; track: string; versionCode: number; }
export interface PublishResult { status: "published" | "stubbed"; externalRef?: string; message: string; }
export interface StorePublisher { store: StoreKind; label: string; live: boolean; publish(i: PublishInput): Promise<PublishResult>; }
export class GooglePlayPublisher implements StorePublisher {}   // ctor(serviceAccountJson, fetchImpl?)
export class StubGooglePlayPublisher implements StorePublisher {}
export class AppStoreComingSoonPublisher implements StorePublisher {}  // publish() throws AppStoreComingSoonError
export class AppStoreComingSoonError extends Error {}
export function createStorePublishers(env: NodeJS.ProcessEnv): Map<StoreKind, StorePublisher>;
```

GooglePlayPublisher flow (spec §4): JWT RS256 via `createSign("RSA-SHA256")` → token exchange → edits insert → bundle/apk upload (raw body, `application/octet-stream`) → track PUT → commit. fetch injectable for tests.

- [ ] Tests: mocked fetch asserts 5-call sequence, URLs, track payload `{ releases: [{ versionCodes: ["<code>"], status: "completed" }] }`, returns externalRef = edit id; API error propagates with Google message; stub returns `stubbed`; app_store throws coming-soon; factory env gating (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`)
- [ ] Commit `feat(mobile): google play publisher + app store coming-soon port`

### Task 6: Core + routes + wiring

**Files:**
- Create: `src/mobile/routes.ts` (`registerMobileRoutes(app, { cp, store, assertProjectAccess })`)
- Modify: `src/core/control-plane.ts` (methods + ctor deps `mobileBuilder`, `storePublishers`)
- Modify: `src/index.ts` (factories + boot log + registerMobileRoutes)
- Test: `src/mobile/mobile-flow.test.ts` (ControlPlane-level, InMemoryStore + stub providers)

ControlPlane methods:

```ts
buildMobileApp(projectId, input: { platform: "android" | "ios"; artifactKind?: "aab" | "apk"; versionName?: string }): Promise<MobileBuild>  // queued row; runMobileBuild fire-and-forget
runMobileBuild(buildId): Promise<MobileBuild>   // exported for tests: ensureKeystore → fetch source to temp workDir (reuse existing source-export used by sandbox/archive) → provider.buildAndroid → succeeded|failed
getMobileBuild / listMobileBuilds / publishMobileRelease({ buildId, store, track = "internal" }) / listStoreReleases
```

Mobile-stack gate: project.mobileStack ?? detectMobileStack(latest source listing); 422-style `CantilaError("not_a_mobile_app")` when null; iOS → `ios_coming_soon` error.

Routes (auth identical to existing project routes): POST/GET builds, GET build, GET artifact (stream file, correct content-type, 404 until succeeded), POST/GET releases.

- [ ] Flow tests: android build on expo project succeeds (stub) with versionCode auto-increment 1→2; non-mobile project rejected; ios rejected with coming-soon; publish records `stubbed` release by default and `published` with a fake live publisher injected
- [ ] Commit `feat(mobile): build + publish core, HTTP routes, boot wiring`

### Task 7: MCP tools

**Files:**
- Modify: `src/mcp/tools.ts`

- [ ] Add `cantila_build_mobile` (projectId, platform, artifactKind?), `cantila_publish_mobile` (projectId, buildId, store, track?), `cantila_list_mobile_builds` (projectId) — tenant-guarded, text() summaries
- [ ] Commit `feat(mcp): mobile build/publish tools`

### Task 8: Control-plane verification

- [ ] `npm test` all green, `npm run typecheck` green, `npm run build` green
- [ ] Commit any fixes

### Task 9: Console — Mobile ops tab

**Files (cantila-console):**
- Modify: `src/lib/api.ts` (ApiMobileBuild, ApiStoreRelease types; api.buildMobile, api.listMobileBuilds, api.publishMobileRelease, api.listStoreReleases, builderApi.mobileArtifactHref)
- Modify: `src/components/workspace/OpsDrawer.tsx` (tab `mobile`, Smartphone icon)
- Create: `src/components/ProjectMobilePanel.tsx` (modeled on ProjectDeploysPanel: build button + kind select, iOS disabled "Coming soon" pill, build list with status badge/version/size/download, publish-to-Play with track select, releases list; poll every 4s while a build is queued/building)

- [ ] Implement; `npm run build` green
- [ ] Commit `feat(mobile): Mobile ops tab — build + publish to Google Play`

### Task 10: Finish

- [ ] Both repos: feature branches pushed (`feat/mobile-builds-store-publish`); restore stashed console OpsDrawer WIP
- [ ] Report: activation env vars (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `MOBILE_BUILDER=docker`), Play first-upload caveat, iOS roadmap
