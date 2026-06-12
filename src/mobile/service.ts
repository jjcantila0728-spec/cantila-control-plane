/* ============================================================
   MobileService — orchestrates the mobile pipeline end-to-end:

     detect stack → keystore → build (async) → artifact →
     publish to store under Cantila's developer account

   Lives beside the ControlPlane (like the Cantilapay services)
   rather than inside it: the 6k-line core stays untouched, and
   the service depends only on narrow source-access callbacks the
   ControlPlane already exposes (listProjectFiles/readProjectFile).
   Spec 2026-06-11 §6.
   ============================================================ */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Store } from "../domain/store";
import type {
  MobileBuild,
  Project,
  StoreKind,
  StoreRelease,
} from "../domain/types";
import { detectMobileStack, type MobileStack } from "../git/detect-stack";
import {
  IosBuildUnavailableError,
  type MobileBuildProvider,
} from "./build-provider";
import { defaultApplicationId, ensureKeystore } from "./keystore";
import {
  AppStoreComingSoonError,
  type StorePublisher,
} from "./store-publisher";

/** Caller-fixable failure with an HTTP-mappable code. */
export class MobileError extends Error {
  constructor(
    public code:
      | "project_not_found"
      | "not_a_mobile_app"
      | "ios_coming_soon"
      | "app_store_coming_soon"
      | "build_not_found"
      | "build_not_ready"
      | "invalid_track",
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "MobileError";
  }
}

const PLAY_TRACKS = new Set(["internal", "alpha", "beta", "production"]);

export interface MobileServiceDeps {
  store: Store;
  builder: MobileBuildProvider;
  publishers: Map<StoreKind, StorePublisher>;
  /** Blob paths of the project's connected repo (null = no repo). */
  listFiles(projectId: string): Promise<string[] | null>;
  /** UTF-8 content of one repo file (null = missing). */
  readFile(projectId: string, path: string): Promise<string | null>;
  /** Where finished artifacts are stored. Default data/mobile-artifacts. */
  artifactDir?: string;
  /** When false, buildMobileApp only queues — the caller drives runBuild.
   *  Tests use this for determinism. Default true. */
  autoRun?: boolean;
}

export interface BuildMobileInput {
  platform: "android" | "ios";
  artifactKind?: "aab" | "apk";
  versionName?: string;
}

export interface PublishMobileInput {
  buildId: string;
  store: StoreKind;
  track?: string;
}

export class MobileService {
  constructor(private deps: MobileServiceDeps) {}

  private get artifactDir(): string {
    return this.deps.artifactDir ?? join("data", "mobile-artifacts");
  }

  /** The project's mobile stack, detecting + persisting it when unset.
   *  Re-detects when the stored value is missing so projects that gained
   *  a mobile app after creation pick it up on the next build. */
  async resolveMobileStack(project: Project): Promise<MobileStack | null> {
    if (project.mobileStack) return project.mobileStack as MobileStack;
    const paths = await this.deps.listFiles(project.id);
    if (!paths) return null;
    const info = await detectMobileStack(paths, (p) =>
      this.deps.readFile(project.id, p),
    );
    if (!info) return null;
    await this.deps.store.updateProject(project.id, {
      mobileStack: info.mobileStack,
    });
    return info.mobileStack;
  }

  /** Queue a mobile build. Returns the queued row immediately; the build
   *  itself runs in the background (poll getBuild / list to follow it). */
  async buildMobileApp(
    projectId: string,
    input: BuildMobileInput,
  ): Promise<MobileBuild> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) {
      throw new MobileError("project_not_found", "project not found", 404);
    }
    if (input.platform === "ios") {
      throw new MobileError(
        "ios_coming_soon",
        new IosBuildUnavailableError().message,
        409,
      );
    }
    const mobileStack = await this.resolveMobileStack(project);
    if (!mobileStack) {
      throw new MobileError(
        "not_a_mobile_app",
        "No mobile app detected in this project. Supported stacks: Expo, React Native, Flutter, Capacitor, native Android (Gradle). Add one — or create the project from a mobile template — then build again.",
        422,
      );
    }

    let applicationId = project.androidApplicationId;
    if (!applicationId) {
      applicationId = defaultApplicationId(project.slug);
      await this.deps.store.updateProject(project.id, {
        androidApplicationId: applicationId,
      });
    }

    const existing = await this.deps.store.listMobileBuilds(projectId);
    const versionCode =
      existing.reduce((max, b) => Math.max(max, b.versionCode), 0) + 1;

    const build = await this.deps.store.createMobileBuild({
      id: `mb_${randomUUID()}`,
      projectId,
      platform: "android",
      mobileStack,
      status: "queued",
      artifactKind: input.artifactKind ?? "aab",
      applicationId,
      versionCode,
      versionName: input.versionName ?? `1.0.${versionCode}`,
      createdAt: new Date().toISOString(),
    });

    // Fire-and-forget — same posture as deploys. runBuild flips the row.
    if (this.deps.autoRun !== false) {
      void this.runBuild(build.id).catch(() => {
        /* runBuild persists its own failures; never unhandled-reject */
      });
    }

    return build;
  }

  /** Execute one queued build. Exported for deterministic tests. */
  async runBuild(buildId: string): Promise<MobileBuild> {
    let build = await this.deps.store.getMobileBuild(buildId);
    if (!build) throw new MobileError("build_not_found", "build not found", 404);
    const project = await this.deps.store.getProject(build.projectId);
    if (!project) {
      return this.deps.store.updateMobileBuild(buildId, {
        status: "failed",
        error: "project was deleted while the build was queued",
        finishedAt: new Date().toISOString(),
      });
    }

    build = await this.deps.store.updateMobileBuild(buildId, {
      status: "building",
    });

    let workDir: string | null = null;
    try {
      const keystore = await ensureKeystore(project, this.deps.store);
      // The stub builder never reads source — skip the (slow) repo walk
      // and hand it an empty scratch dir.
      workDir = await mkdtemp(join(tmpdir(), "cantila-mbuild-"));
      if (this.deps.builder.live) {
        await this.materializeSource(project.id, workDir);
      }
      const outDir = join(this.artifactDir, project.id);
      const result = await this.deps.builder.buildAndroid({
        projectId: project.id,
        workDir,
        mobileStack: build.mobileStack as MobileStack,
        applicationId: build.applicationId,
        versionCode: build.versionCode,
        versionName: build.versionName,
        artifactKind: build.artifactKind,
        keystore,
        outDir,
      });
      return await this.deps.store.updateMobileBuild(buildId, {
        status: "succeeded",
        artifactPath: result.artifactPath,
        artifactSize: result.sizeBytes,
        log: result.log.slice(-20_000),
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return await this.deps.store.updateMobileBuild(buildId, {
        status: "failed",
        error: message.slice(0, 4000),
        finishedAt: new Date().toISOString(),
      });
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  async getBuild(projectId: string, buildId: string): Promise<MobileBuild> {
    const build = await this.deps.store.getMobileBuild(buildId);
    if (!build || build.projectId !== projectId) {
      throw new MobileError("build_not_found", "build not found", 404);
    }
    return build;
  }

  listBuilds(projectId: string): Promise<MobileBuild[]> {
    return this.deps.store.listMobileBuilds(projectId);
  }

  listReleases(projectId: string): Promise<StoreRelease[]> {
    return this.deps.store.listStoreReleases(projectId);
  }

  /** Submit a finished build to a store. The release row records the
   *  outcome: published (live publisher), stubbed (publisher offline),
   *  or failed (provider rejected it — error carries the reason). */
  async publishRelease(
    projectId: string,
    input: PublishMobileInput,
  ): Promise<StoreRelease> {
    const build = await this.getBuild(projectId, input.buildId);
    if (build.status !== "succeeded" || !build.artifactPath) {
      throw new MobileError(
        "build_not_ready",
        `build is ${build.status} — only a succeeded build can be published`,
        409,
      );
    }
    const track = input.track ?? "internal";
    if (input.store === "google_play" && !PLAY_TRACKS.has(track)) {
      throw new MobileError(
        "invalid_track",
        `unknown Play track "${track}" — use internal, alpha, beta or production`,
        422,
      );
    }
    const publisher = this.deps.publishers.get(input.store);
    if (!publisher || input.store === "app_store") {
      throw new MobileError(
        "app_store_coming_soon",
        new AppStoreComingSoonError().message,
        409,
      );
    }

    const now = new Date().toISOString();
    const release = await this.deps.store.createStoreRelease({
      id: `sr_${randomUUID()}`,
      projectId,
      buildId: build.id,
      store: input.store,
      track,
      status: "submitted",
      createdAt: now,
      updatedAt: now,
    });

    try {
      const result = await publisher.publish({
        applicationId: build.applicationId,
        artifactPath: build.artifactPath,
        artifactKind: build.artifactKind,
        track,
        versionCode: build.versionCode,
      });
      return await this.deps.store.updateStoreRelease(release.id, {
        status: result.status,
        externalRef: result.externalRef,
        error: undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return await this.deps.store.updateStoreRelease(release.id, {
        status: "failed",
        error: message.slice(0, 4000),
      });
    }
  }

  /** Write every repo blob into `dir` for a real (docker) build. */
  private async materializeSource(projectId: string, dir: string): Promise<void> {
    const paths = await this.deps.listFiles(projectId);
    if (!paths) throw new Error("project has no connected repo to build from");
    for (const path of paths) {
      const content = await this.deps.readFile(projectId, path);
      if (content === null) continue;
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  }
}
