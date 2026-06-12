/* ============================================================
   Mobile HTTP surface (spec 2026-06-11 §6) — build mobile apps
   and publish them to app stores. Registered from index.ts with
   the same per-project access guard as every other project route.
   ============================================================ */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { Project, StoreKind } from "../domain/types";
import { MobileError, type MobileService } from "./service";

export interface MobileRouteDeps {
  service: MobileService;
  /** index.ts's project guard: 404/403 already sent on null. */
  assertProjectAccess(
    req: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
  ): Promise<Project | null>;
}

const sendMobileError = (reply: FastifyReply, err: unknown): void => {
  if (err instanceof MobileError) {
    reply.code(err.statusCode).send({ error: err.message, code: err.code });
    return;
  }
  throw err;
};

export function registerMobileRoutes(
  app: FastifyInstance,
  deps: MobileRouteDeps,
): void {
  const { service, assertProjectAccess } = deps;

  // Queue a mobile build. Returns the queued row; poll the list/detail
  // endpoints to follow it to succeeded/failed.
  app.post("/v1/projects/:id/mobile/builds", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await assertProjectAccess(request, reply, id))) return;
    const body = (request.body ?? {}) as {
      platform?: string;
      artifactKind?: string;
      versionName?: string;
    };
    if (body.platform !== "android" && body.platform !== "ios") {
      reply.code(400).send({ error: 'platform must be "android" or "ios"' });
      return;
    }
    if (
      body.artifactKind !== undefined &&
      body.artifactKind !== "aab" &&
      body.artifactKind !== "apk"
    ) {
      reply.code(400).send({ error: 'artifactKind must be "aab" or "apk"' });
      return;
    }
    try {
      const build = await service.buildMobileApp(id, {
        platform: body.platform,
        artifactKind: body.artifactKind as "aab" | "apk" | undefined,
        versionName: body.versionName,
      });
      reply.code(201).send(build);
    } catch (err) {
      sendMobileError(reply, err);
    }
  });

  app.get("/v1/projects/:id/mobile/builds", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await assertProjectAccess(request, reply, id))) return;
    return { builds: await service.listBuilds(id) };
  });

  app.get("/v1/projects/:id/mobile/builds/:buildId", async (request, reply) => {
    const { id, buildId } = request.params as { id: string; buildId: string };
    if (!(await assertProjectAccess(request, reply, id))) return;
    try {
      return await service.getBuild(id, buildId);
    } catch (err) {
      sendMobileError(reply, err);
    }
  });

  // Download the signed artifact (.aab/.apk) of a succeeded build.
  app.get(
    "/v1/projects/:id/mobile/builds/:buildId/artifact",
    async (request, reply) => {
      const { id, buildId } = request.params as { id: string; buildId: string };
      if (!(await assertProjectAccess(request, reply, id))) return;
      try {
        const build = await service.getBuild(id, buildId);
        if (build.status !== "succeeded" || !build.artifactPath) {
          reply.code(404).send({
            error: `no artifact — build is ${build.status}`,
            code: "artifact_not_ready",
          });
          return;
        }
        const { size } = await stat(build.artifactPath);
        reply
          .header("Content-Type", "application/octet-stream")
          .header(
            "Content-Disposition",
            `attachment; filename="${basename(build.artifactPath)}"`,
          )
          .header("Content-Length", size);
        return reply.send(createReadStream(build.artifactPath));
      } catch (err) {
        sendMobileError(reply, err);
      }
    },
  );

  // Submit a finished build to a store (Google Play live today; App Store
  // returns a typed coming-soon 409 until Cantila's Apple account exists).
  app.post("/v1/projects/:id/mobile/releases", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await assertProjectAccess(request, reply, id))) return;
    const body = (request.body ?? {}) as {
      buildId?: string;
      store?: string;
      track?: string;
    };
    if (!body.buildId) {
      reply.code(400).send({ error: "buildId is required" });
      return;
    }
    if (body.store !== "google_play" && body.store !== "app_store") {
      reply
        .code(400)
        .send({ error: 'store must be "google_play" or "app_store"' });
      return;
    }
    try {
      const release = await service.publishRelease(id, {
        buildId: body.buildId,
        store: body.store as StoreKind,
        track: body.track,
      });
      reply.code(201).send(release);
    } catch (err) {
      sendMobileError(reply, err);
    }
  });

  app.get("/v1/projects/:id/mobile/releases", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await assertProjectAccess(request, reply, id))) return;
    return { releases: await service.listReleases(id) };
  });
}
