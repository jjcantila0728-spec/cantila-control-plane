/* ============================================================
   MobileBuildProvider — turn project source into a signed
   Android artifact (.aab / .apk). Spec 2026-06-11 §2.

   Same env-gated port pattern as MailProvider / TelephonyProvider:

   - StubMobileBuildProvider (default): writes a deterministic
     placeholder artifact so the entire pipeline — build rows,
     artifact download, store publishing, console UI — works on
     any host. What StubMailProvider is to SMTP, this is to Gradle.
   - DockerMobileBuildProvider (MOBILE_BUILDER=docker): runs the
     real per-stack build in a throwaway container. Requires a
     Docker socket on the host, which prod's Coolify container
     does not have today — same activation posture as the
     FLEET_SANDBOX=docker sandbox runner.

   iOS is structurally present but unimplemented: binaries require
   macOS tooling. buildIos() throws IosBuildUnavailableError until
   a mac builder (or EAS-style remote) exists.
   ============================================================ */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MobileStack } from "../git/detect-stack";
import type { KeystoreMaterial } from "./keystore";

const execFileAsync = promisify(execFile);

export interface AndroidBuildInput {
  projectId: string;
  /** Checked-out project source on local disk. */
  workDir: string;
  mobileStack: MobileStack;
  applicationId: string;
  versionCode: number;
  versionName: string;
  artifactKind: "aab" | "apk";
  keystore: KeystoreMaterial;
  /** Directory the finished artifact is written into. */
  outDir: string;
}

export interface AndroidBuildResult {
  artifactPath: string;
  sizeBytes: number;
  log: string;
}

export class IosBuildUnavailableError extends Error {
  constructor() {
    super(
      "iOS builds are coming soon — they require a macOS build host, which Cantila does not run yet. Android builds and Google Play publishing are available today.",
    );
    this.name = "IosBuildUnavailableError";
  }
}

export interface MobileBuildProvider {
  label: string;
  live: boolean;
  buildAndroid(input: AndroidBuildInput): Promise<AndroidBuildResult>;
  buildIos(): never;
}

const artifactName = (i: AndroidBuildInput) =>
  `${i.projectId}-${i.versionCode}.${i.artifactKind}`;

/* ----- stub ----- */

export class StubMobileBuildProvider implements MobileBuildProvider {
  label = "stub";
  live = false;

  async buildAndroid(input: AndroidBuildInput): Promise<AndroidBuildResult> {
    await mkdir(input.outDir, { recursive: true });
    const artifactPath = join(input.outDir, artifactName(input));
    const body = [
      `CANTILA-STUB-${input.artifactKind.toUpperCase()}`,
      `applicationId=${input.applicationId}`,
      `versionCode=${input.versionCode}`,
      `versionName=${input.versionName}`,
      `stack=${input.mobileStack}`,
    ].join("\n");
    await writeFile(artifactPath, body, "utf8");
    const { size } = await stat(artifactPath);
    return {
      artifactPath,
      sizeBytes: size,
      log: `[stub] simulated ${input.mobileStack} android build → ${artifactName(input)} (set MOBILE_BUILDER=docker on a host with a Docker socket for real builds)`,
    };
  }

  buildIos(): never {
    throw new IosBuildUnavailableError();
  }
}

/* ----- docker ----- */

export interface DockerBuildPlan {
  image: string;
  /** Shell script run inside the container with /app = workDir. */
  script: string;
}

/** Pure command planner — unit-testable without Docker. The container gets
 *  the source at /app, the keystore at /app/.cantila/release.keystore, and
 *  signing config via ORG_GRADLE_PROJECT_* env (consumed by the Gradle
 *  signing block Cantila's mobile templates ship with). */
export function dockerBuildPlan(input: AndroidBuildInput): DockerBuildPlan {
  const gradleTask = input.artifactKind === "apk" ? "assembleRelease" : "bundleRelease";
  const gradle = `cd android && chmod +x ./gradlew && ./gradlew ${gradleTask} --no-daemon`;
  switch (input.mobileStack) {
    case "expo":
      return {
        image: "reactnativecommunity/react-native-android:latest",
        script: `npm ci && npx expo prebuild --platform android --no-install && ${gradle}`,
      };
    case "react-native":
      return {
        image: "reactnativecommunity/react-native-android:latest",
        script: `npm ci && ${gradle}`,
      };
    case "flutter":
      return {
        image: "ghcr.io/cirruslabs/flutter:stable",
        script:
          input.artifactKind === "apk"
            ? "flutter pub get && flutter build apk --release"
            : "flutter pub get && flutter build appbundle --release",
      };
    case "capacitor":
      return {
        image: "reactnativecommunity/react-native-android:latest",
        script: `npm ci && npm run build && npx cap sync android && ${gradle}`,
      };
    case "android-native":
      return {
        image: "reactnativecommunity/react-native-android:latest",
        script: `chmod +x ./gradlew && ./gradlew ${gradleTask} --no-daemon`,
      };
  }
}

/** Where each stack's Gradle/Flutter build drops its release artifact,
 *  relative to the work dir. */
function expectedOutputs(input: AndroidBuildInput): string[] {
  const aab = input.artifactKind === "aab";
  if (input.mobileStack === "flutter") {
    return aab
      ? ["build/app/outputs/bundle/release/app-release.aab"]
      : ["build/app/outputs/flutter-apk/app-release.apk"];
  }
  const base = input.mobileStack === "android-native" ? "" : "android/";
  return aab
    ? [`${base}app/build/outputs/bundle/release/app-release.aab`]
    : [`${base}app/build/outputs/apk/release/app-release.apk`];
}

export class DockerMobileBuildProvider implements MobileBuildProvider {
  label = "docker";
  live = true;

  async buildAndroid(input: AndroidBuildInput): Promise<AndroidBuildResult> {
    const plan = dockerBuildPlan(input);
    // Materialize the keystore inside the work dir so the container sees it.
    const keystoreDir = join(input.workDir, ".cantila");
    await mkdir(keystoreDir, { recursive: true });
    await writeFile(
      join(keystoreDir, "release.keystore"),
      Buffer.from(input.keystore.keystoreB64, "base64"),
    );

    const args = [
      "run", "--rm",
      "-v", `${input.workDir}:/app`,
      "-w", "/app",
      "-e", `ORG_GRADLE_PROJECT_CANTILA_STORE_FILE=/app/.cantila/release.keystore`,
      "-e", `ORG_GRADLE_PROJECT_CANTILA_STORE_PASSWORD=${input.keystore.storePassword}`,
      "-e", `ORG_GRADLE_PROJECT_CANTILA_KEY_ALIAS=${input.keystore.alias}`,
      "-e", `ORG_GRADLE_PROJECT_CANTILA_KEY_PASSWORD=${input.keystore.keyPassword}`,
      "-e", `CANTILA_APPLICATION_ID=${input.applicationId}`,
      "-e", `CANTILA_VERSION_CODE=${String(input.versionCode)}`,
      "-e", `CANTILA_VERSION_NAME=${input.versionName}`,
      plan.image,
      "bash", "-lc", plan.script,
    ];
    const { stdout, stderr } = await execFileAsync("docker", args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
    const log = `${stdout}\n${stderr}`.trim();

    // Copy the artifact out of the work dir into the artifact store.
    let built: string | null = null;
    for (const rel of expectedOutputs(input)) {
      const candidate = join(input.workDir, rel);
      try {
        await stat(candidate);
        built = candidate;
        break;
      } catch {
        /* try the next conventional location */
      }
    }
    if (!built) {
      throw new Error(
        `docker build finished but no ${input.artifactKind} artifact was found (looked in ${expectedOutputs(input).join(", ")})\n${log.slice(-4000)}`,
      );
    }
    await mkdir(input.outDir, { recursive: true });
    const artifactPath = join(input.outDir, artifactName(input));
    const { copyFile } = await import("node:fs/promises");
    await copyFile(built, artifactPath);
    const { size } = await stat(artifactPath);
    return { artifactPath, sizeBytes: size, log };
  }

  buildIos(): never {
    throw new IosBuildUnavailableError();
  }
}

/* ----- factory ----- */

export function createMobileBuildProvider(
  env: Record<string, string | undefined>,
): MobileBuildProvider {
  if (env.MOBILE_BUILDER === "docker") return new DockerMobileBuildProvider();
  return new StubMobileBuildProvider();
}
