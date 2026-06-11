/* ============================================================
   detectStack — map a repo's file tree to the Coolify build
   configuration that can actually run it. This is what lets the
   deploy pipeline support ANY stack — frontend-only sites,
   backend services, and full Docker apps — instead of assuming
   "Node on port 3000" for everything.

   Pure: takes a path list (+ optional file reader for
   Dockerfile EXPOSE / package.json) and returns a typed result.
   Network-free, fully unit-testable.
   ============================================================ */

/** Coolify build packs the data plane can create apps with. */
export type BuildPack = "nixpacks" | "dockerfile" | "dockercompose" | "static";

export interface StackInfo {
  buildPack: BuildPack;
  /** Container port the app listens on (Coolify `ports_exposes`). */
  port: number;
  /** Human-readable label for events/UI ("Next.js", "Python", …). */
  stack: string;
}

export type FileReader = (path: string) => Promise<string | null>;

const has = (paths: Set<string>, ...names: string[]) =>
  names.some((n) => paths.has(n));

/** Detect the stack from a repo file listing.
 *
 *  Precedence mirrors what a developer would expect Coolify to do:
 *    1. docker-compose at the root — the app declares its own topology.
 *    2. Dockerfile at the root — the app declares its own build; port
 *       read from `EXPOSE` when a reader is supplied.
 *    3. A language/build manifest — Nixpacks builds it; the port is the
 *       framework's conventional default (every Cantila template also
 *       honors $PORT, which Coolify injects from ports_exposes).
 *    4. Bare index.html — static site served by nginx on 80.
 *    5. Unknown — Nixpacks + 3000, the legacy behavior. */
export async function detectStack(
  paths: string[],
  read?: FileReader,
): Promise<StackInfo> {
  // Root-level files decide the build; nested manifests (e.g. a
  // examples/package.json in a Go repo) must not.
  const root = new Set(paths.filter((p) => !p.includes("/")));
  const all = paths;

  if (has(root, "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")) {
    return { buildPack: "dockercompose", port: 3000, stack: "Docker Compose" };
  }

  if (root.has("Dockerfile")) {
    let port = 3000;
    if (read) {
      const dockerfile = await read("Dockerfile").catch(() => null);
      const m = dockerfile?.match(/^\s*EXPOSE\s+(\d{2,5})/im);
      if (m) port = parseInt(m[1], 10);
    }
    return { buildPack: "dockerfile", port, stack: "Dockerfile" };
  }

  if (root.has("package.json")) {
    let stack = "Node.js";
    if (read) {
      const raw = await read("package.json").catch(() => null);
      try {
        const pkg = raw ? (JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) : null;
        const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
        if (deps["next"]) stack = "Next.js";
        else if (deps["nuxt"]) stack = "Nuxt";
        else if (deps["@remix-run/node"]) stack = "Remix";
        else if (deps["astro"]) stack = "Astro";
        else if (deps["@nestjs/core"]) stack = "NestJS";
        else if (deps["express"] || deps["fastify"] || deps["koa"]) stack = "Node.js API";
        else if (deps["react"] || deps["vue"] || deps["svelte"]) stack = "Node.js SPA";
      } catch {
        /* malformed package.json — keep the generic label */
      }
    }
    return { buildPack: "nixpacks", port: 3000, stack };
  }

  if (has(root, "requirements.txt", "pyproject.toml", "Pipfile", "manage.py", "main.py", "app.py")) {
    return { buildPack: "nixpacks", port: 8000, stack: "Python" };
  }
  if (root.has("go.mod")) {
    return { buildPack: "nixpacks", port: 8080, stack: "Go" };
  }
  if (root.has("Gemfile")) {
    return { buildPack: "nixpacks", port: 3000, stack: "Ruby" };
  }
  if (has(root, "composer.json", "index.php", "artisan")) {
    return { buildPack: "nixpacks", port: 80, stack: "PHP" };
  }
  if (root.has("Cargo.toml")) {
    return { buildPack: "nixpacks", port: 8080, stack: "Rust" };
  }
  if (has(root, "pom.xml", "build.gradle", "build.gradle.kts")) {
    return { buildPack: "nixpacks", port: 8080, stack: "Java" };
  }
  if (has(root, "mix.exs")) {
    return { buildPack: "nixpacks", port: 4000, stack: "Elixir" };
  }
  if (root.has("Program.cs") || all.some((p) => p.endsWith(".csproj") && !p.includes("/"))) {
    return { buildPack: "nixpacks", port: 8080, stack: ".NET" };
  }
  if (has(root, "deno.json", "deno.jsonc")) {
    return { buildPack: "nixpacks", port: 8000, stack: "Deno" };
  }

  if (root.has("index.html")) {
    return { buildPack: "static", port: 80, stack: "Static site" };
  }

  return { buildPack: "nixpacks", port: 3000, stack: "App" };
}
