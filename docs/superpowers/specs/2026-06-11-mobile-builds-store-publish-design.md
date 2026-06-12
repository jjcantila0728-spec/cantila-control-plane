# Mobile Builds + Store Publishing — Design

**Date:** 2026-06-11
**Status:** Approved (autonomous session; owner directive: "make building mobile app native to cantila app … publish to appstore and google play store")
**Repos:** cantila-control-plane (primary), cantila-console (UI)

## Goal

Cantila can build mobile apps (Android now, iOS when infra exists) from a project's
source and publish them directly to app stores under Cantila's own developer
accounts: Google Play Console (active today) and Apple App Store (coming soon).

## Constraints & context

- Prod control-plane is a single Node/Fastify container on Coolify with **no Docker
  socket** today → real container builds are infra-gated, same as SandboxRunner.
- Prod DB schema changes must go through `boot-migrations.ts` (additive, idempotent).
- Everything follows the env-gated port/adapter pattern (stub default, live behind env).
- Mobile apps may also have a backend: mobile build is **additive** to the existing
  web deploy pipeline, never a replacement.
- iOS binaries require macOS tooling; Play publishing works headless via the
  androidpublisher v3 REST API with a service account.

## Architecture

### 1. Stack detection (`src/git/detect-stack.ts`)

New exported `detectMobileStack(files)` returning `MobileStackInfo | null`:

| mobileStack  | Signals                                                        |
|--------------|----------------------------------------------------------------|
| `expo`       | package.json deps include `expo` (app.json/app.config optional) |
| `react-native` | deps include `react-native` without `expo`                   |
| `flutter`    | `pubspec.yaml` with `flutter:` dependency                      |
| `capacitor`  | deps include `@capacitor/core` / capacitor.config.{ts,json}    |
| `android-native` | `android/build.gradle(.kts)` or root `build.gradle` + `AndroidManifest.xml` |

Detection runs during deploy/bootstrap alongside `detectStack`; result persisted to
`Project.mobileStack`. Web buildPack/appPort behavior unchanged.

### 2. MobileBuildProvider port (`src/mobile/build-provider.ts`)

```ts
interface MobileBuildProvider {
  label: string;
  live: boolean;
  buildAndroid(input: AndroidBuildInput): Promise<AndroidBuildResult>;
  buildIos(input: IosBuildInput): Promise<never>; // throws IosBuildUnavailableError until macOS builder exists
}
```

- `AndroidBuildInput`: projectId, workDir/source ref, mobileStack, applicationId,
  versionCode, versionName, keystore (path + passwords), artifact kind `aab | apk`.
- `AndroidBuildResult`: artifactPath, artifactKind, sizeBytes, log.
- **StubMobileBuildProvider** (default): writes a small deterministic placeholder
  artifact, returns a synthetic log. Keeps the whole flow testable offline and in prod
  until the build node is ready.
- **DockerMobileBuildProvider** (`MOBILE_BUILDER=docker`): runs the per-stack build in
  a container (`docker run --rm -v work:/app <image> <cmd>`):
  - expo / react-native: `npx expo prebuild -p android` (expo only) then
    `./gradlew bundleRelease` in `reactnativecommunity/react-native-android`.
  - flutter: `flutter build appbundle --release` in `ghcr.io/cirruslabs/flutter`.
  - capacitor: `npm ci && npm run build && npx cap sync android` then Gradle.
  - android-native: `./gradlew bundleRelease` in a JDK+SDK image.
  - Signing via Gradle `-P` properties pointing at the mounted keystore.
- Factory `createMobileBuildProvider(env)` in the same file; wired in `src/index.ts`
  with the usual `[mobile-builder] <label> (live|stub)` boot log.

### 3. Signing (`src/mobile/keystore.ts`)

- Per-project Android keystore generated on first build (`keytool -genkeypair`,
  RSA 2048, 30y validity, alias `cantila`). When `keytool` is unavailable (stub/prod
  without JDK) a placeholder keystore record is created with `live=false`.
- Keystore bytes + passwords stored on the project, encrypted at rest with
  `CANTILA_SECRET_KEY` (same AES-GCM helper as mailbox SMTP creds).
- `applicationId` default: `app.cantila.<slug>` (sanitized); stored on the project,
  overridable via API input.

### 4. StorePublisher ports (`src/mobile/store-publisher.ts`)

```ts
interface StorePublisher {
  store: "google_play" | "app_store";
  label: string;
  live: boolean;
  publish(input: PublishInput): Promise<PublishResult>;
}
```

- **GooglePlayPublisher** — live when `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (full JSON,
  is_literal:false in Coolify) is set. Flow against
  `https://androidpublisher.googleapis.com/androidpublisher/v3`:
  1. mint OAuth token: RS256 JWT signed with the service-account private key via
     `node:crypto` (no googleapis dependency), exchanged at `oauth2.googleapis.com/token`,
     scope `https://www.googleapis.com/auth/androidpublisher`;
  2. `POST /applications/{pkg}/edits` (insert);
  3. upload AAB to `/upload/...{pkg}/edits/{id}/bundles` (apk endpoint for apk);
  4. `PUT .../edits/{id}/tracks/{track}` with the new versionCode, status `completed`;
  5. `POST .../edits/{id}:commit`.
  Tracks: `internal` (default) | `alpha` | `beta` | `production`.
  Note: the very first APK/AAB of a new package must be uploaded manually in Play
  Console once (Google requirement); surfaced as a clear error message.
- **StubGooglePlayPublisher** — default; records the release as `stubbed`.
- **AppStorePublisher** — permanent port; current adapter returns
  `app_store_coming_soon` unless `APPSTORE_CONNECT_ISSUER_ID` + `APPSTORE_CONNECT_KEY_ID`
  + `APPSTORE_CONNECT_PRIVATE_KEY` are set, at which point it still returns
  `not_implemented` for binary upload (requires macOS Transporter) but validates the
  credential contract so go-live is an adapter fill-in, not a redesign.
- Factory `createStorePublishers(env)` → `Map<store, StorePublisher>`.

### 5. Data model (prisma + boot-migrations)

New models (CREATE TABLE IF NOT EXISTS in boot-migrations; also added to
schema.prisma for dev):

- **MobileBuild**: id, projectId, platform (`android|ios`), mobileStack, status
  (`queued|building|succeeded|failed`), artifactKind (`aab|apk`), artifactPath,
  artifactSize, applicationId, versionCode, versionName, log, error, createdAt,
  finishedAt.
- **StoreRelease**: id, projectId, buildId, store (`google_play|app_store`), track,
  status (`submitted|published|stubbed|failed`), externalRef, error, createdAt,
  updatedAt.

Project columns (ALTER TABLE ADD COLUMN IF NOT EXISTS): `mobileStack TEXT`,
`androidApplicationId TEXT`, `androidKeystore TEXT` (encrypted blob),
`androidKeystoreSecret TEXT` (encrypted passwords JSON).

### 6. Core + API surface

`ControlPlane` methods: `buildMobileApp`, `getMobileBuild`, `listMobileBuilds`,
`publishMobileRelease`, `listStoreReleases`. Builds run async: row created `queued`,
background promise flips `building → succeeded|failed` (setInterval-free; same
fire-and-forget style as deploys, with an exported `runMobileBuild` for tests).
Version code auto-increments per project (max existing + 1).

HTTP (`src/mobile/routes.ts`, `registerMobileRoutes(app, deps)`, same auth guards as
project routes):

- `POST /v1/projects/:id/mobile/builds` `{ platform, artifactKind?, versionName? }`
- `GET  /v1/projects/:id/mobile/builds`
- `GET  /v1/projects/:id/mobile/builds/:buildId`
- `GET  /v1/projects/:id/mobile/builds/:buildId/artifact` (download)
- `POST /v1/projects/:id/mobile/releases` `{ buildId, store, track? }`
- `GET  /v1/projects/:id/mobile/releases`

MCP tools (`src/mcp/tools.ts`): `cantila_build_mobile`, `cantila_publish_mobile`,
`cantila_list_mobile_builds` — all tenant-guarded via projectId.

### 7. Console (cantila-console)

- New ops tab `mobile` (Smartphone icon) in `OpsDrawer` →
  `ProjectMobilePanel.tsx` modeled on `ProjectDeploysPanel`:
  - "Build Android app" button (+ artifact kind), iOS button disabled with
    "Coming soon" pill;
  - build list: status badge, version, size, artifact download link;
  - per-succeeded-build "Publish to Google Play" with track select; release list
    with store status (`stubbed` shown as "Recorded (publisher offline)").
- `src/lib/api.ts`: `ApiMobileBuild`, `ApiStoreRelease` types + api methods; panel
  polls builds while one is `queued|building`.

### 8. Errors & edge cases

- iOS build/publish → explicit `coming_soon` errors end-to-end (API 409 with code).
- Project with no detected mobile stack → 422 `not_a_mobile_app` listing supported
  stacks (detection re-runs on demand from latest source).
- Play publish without service account env → release recorded `stubbed`, message
  tells operator which env var enables live publishing.
- First-package-upload Google restriction surfaced verbatim from the API error.
- Artifact files stored under `data/mobile-artifacts/<projectId>/` (configurable via
  `MOBILE_ARTIFACT_DIR`); stub artifacts are tiny.

### 9. Testing

Vitest, offline-first:
- detect-stack: one test per mobile stack + negative case.
- stub build flow: queue → succeed, artifact exists, versionCode increments.
- keystore: encrypt/decrypt round-trip.
- GooglePlayPublisher: mocked fetch asserting JWT exchange + edits/upload/track/commit
  sequence and error propagation; stub publisher records `stubbed`.
- routes: build + publish + download happy path, tenant-access denial, iOS 409.

### 10. Activation (ops, post-merge)

1. Set `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` in Coolify (is_literal:false) → Play
   publishing live.
2. Build node with Docker + `MOBILE_BUILDER=docker` → real Android builds (until
   then builds are stub artifacts; flow, data, UI all real).
3. Apple account later: set ASC env + implement Transporter upload in the existing
   adapter.
