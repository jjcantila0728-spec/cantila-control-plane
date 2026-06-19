/* ============================================================
   generateDockerfile — map a detected stack to a canonical,
   layer-cache-friendly multi-stage Dockerfile.

   This is the heart of the fast-build win (plan
   2026-06-18 §Stage 1): replacing Nixpacks — whose cold
   toolchain provisioning and weak caching dominate build time —
   with a Dockerfile whose dependency-install layer (`npm ci`,
   `pip install`, `go mod download`) caches across deploys when
   the manifest is unchanged.

   Pure + offline: takes a `StackInfo` and returns Dockerfile
   text, or `null` when the repo already owns its build (its own
   Dockerfile / compose, or a stack we deliberately leave to
   Nixpacks). Fully unit-testable.
   ============================================================ */

import type { StackInfo } from "../git/detect-stack";

/** Node-family stack labels detect-stack emits for `buildPack: "nixpacks"`
 *  repos that we accelerate with a generated Node Dockerfile. */
const NODE_STACKS = new Set([
  "Node.js",
  "Node.js API",
  "Node.js SPA",
  "Next.js",
  "Nuxt",
  "Remix",
  "Astro",
  "NestJS",
]);

/**
 * Return a generated Dockerfile for a detected stack, or `null` when we
 * should NOT generate one:
 *   - `dockerfile` / `dockercompose` build packs → the repo declares its own
 *     build; the builder uses that verbatim.
 *   - a Nixpacks stack we don't (yet) have a canonical Dockerfile for
 *     (Ruby, PHP, Rust, Java, Elixir, .NET, Deno) → fall back to Nixpacks
 *     rather than ship a half-baked image.
 *
 * Every generated image honours `$PORT` (Cantila injects it) and EXPOSEs the
 * stack's conventional port so the data plane's routing matches today.
 */
export function generateDockerfile(stack: StackInfo): string | null {
  if (stack.buildPack === "dockerfile" || stack.buildPack === "dockercompose") {
    return null;
  }
  if (stack.buildPack === "static") {
    return staticDockerfile();
  }
  // buildPack === "nixpacks": accelerate the common stacks; leave the rest.
  if (NODE_STACKS.has(stack.stack)) return nodeDockerfile(stack.port);
  if (stack.stack === "Python") return pythonDockerfile(stack.port);
  if (stack.stack === "Go") return goDockerfile(stack.port);
  return null;
}

/** Multi-stage Node build. The `npm ci` layer depends only on the lockfiles,
 *  so it caches across deploys until dependencies actually change — the whole
 *  point of moving off Nixpacks. `npm run build --if-present` covers Next /
 *  Vite / tsc apps without assuming a build script exists. */
function nodeDockerfile(port: number): string {
  return [
    "# syntax=docker/dockerfile:1",
    "FROM node:20-alpine AS deps",
    "WORKDIR /app",
    // `.npmrc*` is optional (glob no-ops when absent) — copies it for apps
    // that pin npm behaviour (e.g. the control-plane's legacy-peer-deps=true,
    // needed because the Agent SDK peer-wants zod 4 vs the repo's zod 3) so
    // `npm ci` doesn't die on a peer conflict.
    "COPY package*.json .npmrc* ./",
    "RUN npm ci",
    "",
    "FROM node:20-alpine AS build",
    "WORKDIR /app",
    "COPY --from=deps /app/node_modules ./node_modules",
    "COPY . .",
    "RUN npm run build --if-present",
    "",
    "FROM node:20-alpine AS run",
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    `ENV PORT=${port}`,
    "COPY --from=build /app ./",
    `EXPOSE ${port}`,
    'CMD ["npm", "run", "start"]',
    "",
  ].join("\n");
}

/** Python build. `pip install` caches on requirements.txt. Falls back to a
 *  no-op when there are no requirements so an app.py-only repo still runs. */
function pythonDockerfile(port: number): string {
  return [
    "# syntax=docker/dockerfile:1",
    "FROM python:3.12-slim AS run",
    "WORKDIR /app",
    "ENV PYTHONUNBUFFERED=1",
    `ENV PORT=${port}`,
    "COPY requirements.txt* ./",
    "RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi",
    "COPY . .",
    `EXPOSE ${port}`,
    'CMD ["sh", "-c", "python app.py 2>/dev/null || python main.py"]',
    "",
  ].join("\n");
}

/** Go build. `go mod download` caches on go.mod/go.sum; the binary is built in
 *  a builder stage and copied into a tiny runtime image. */
function goDockerfile(port: number): string {
  return [
    "# syntax=docker/dockerfile:1",
    "FROM golang:1.22-alpine AS build",
    "WORKDIR /src",
    "COPY go.mod go.sum* ./",
    "RUN go mod download",
    "COPY . .",
    "RUN go build -o /out/app ./...",
    "",
    "FROM alpine:3.20 AS run",
    "WORKDIR /app",
    `ENV PORT=${port}`,
    "COPY --from=build /out/app ./app",
    `EXPOSE ${port}`,
    'CMD ["./app"]',
    "",
  ].join("\n");
}

/** Static site served by nginx on 80 — mirrors detect-stack's `static` pack. */
function staticDockerfile(): string {
  return [
    "# syntax=docker/dockerfile:1",
    "FROM nginx:alpine",
    "COPY . /usr/share/nginx/html",
    "EXPOSE 80",
    'CMD ["nginx", "-g", "daemon off;"]',
    "",
  ].join("\n");
}
