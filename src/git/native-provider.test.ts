/* ============================================================
   NativeGitProvider — git plumbing orchestration over faked seams.
   No real git binary, no disk. Asserts parse logic, the write/CAS
   commit sequence, the stale-sha guards, and idempotent provisioning.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { NativeGitProvider, type GitExec, type NativeGitFs } from "./native-provider";
import { GitError } from "./types";

// Paths are built with node:path.join, so expectations use the same (the
// production target is Linux; tests must not assume the host separator).
const REPO_DIR = join("/srv/cantila-git", "acme", "site.git");
const OWNER_DIR = join("/srv/cantila-git", "acme");

type Resp = { code: number; stdout: Buffer };
type Handler = (args: string[], opts: any) => Resp;

interface Recorded {
  args: string[];
  env?: Record<string, string>;
  input?: Buffer;
}

function fakeExec(handler: Handler): { exec: GitExec; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const exec: GitExec = {
    async run(args, opts) {
      calls.push({ args, env: opts.env, input: opts.input });
      const r = handler(args, opts);
      if (r.code !== 0 && !opts.allowFail) {
        // Mirror the real seam: the provider's git() wrapper is what maps a
        // non-zero code to GitError, so just hand the code back here.
      }
      return r;
    },
  };
  return { exec, calls };
}

const ok = (s = "") => ({ code: 0, stdout: Buffer.from(s) });
const fail = (code = 128) => ({ code, stdout: Buffer.from("") });

function fakeFs(exists: boolean): { fs: NativeGitFs; ensured: string[] } {
  const ensured: string[] = [];
  return {
    ensured,
    fs: {
      async ensureDir(dir) {
        ensured.push(dir);
      },
      async exists() {
        return exists;
      },
    },
  };
}

function provider(handler: Handler, exists = false) {
  const { exec, calls } = fakeExec(handler);
  const { fs, ensured } = fakeFs(exists);
  const p = new NativeGitProvider({
    root: "/srv/cantila-git",
    publicBase: "https://git.cantila.app/",
    exec,
    fs,
    indexSuffix: () => "test", // deterministic GIT_INDEX_FILE
  });
  return { p, calls, ensured };
}

const repo = { owner: "acme", repo: "site" };

test("getDefaultBranch reads symbolic-ref, falls back to main", async () => {
  const a = provider((args) =>
    args[0] === "symbolic-ref" ? ok("develop\n") : fail(),
  );
  assert.equal(await a.p.getDefaultBranch(repo), "develop");

  const b = provider((args) =>
    args[0] === "symbolic-ref" ? fail(128) : fail(),
  );
  assert.equal(await b.p.getDefaultBranch(repo), "main");
});

test("listTree parses ls-tree -r -t into blob/tree nodes", async () => {
  const out =
    "100644 blob aaa1\tindex.html\n" +
    "040000 tree bbb2\tsrc\n" +
    "100644 blob ccc3\tsrc/app.js\n";
  const { p, calls } = provider((args) => {
    if (args[0] === "symbolic-ref") return ok("main\n");
    if (args[0] === "ls-tree") return ok(out);
    return fail();
  });
  const tree = await p.listTree(repo);
  assert.deepEqual(tree, [
    { path: "index.html", type: "blob", sha: "aaa1" },
    { path: "src", type: "tree", sha: "bbb2" },
    { path: "src/app.js", type: "blob", sha: "ccc3" },
  ]);
  // recursive + tree entries requested, inside the project's bare repo dir
  const ls = calls.find((c) => c.args[0] === "ls-tree")!;
  assert.deepEqual(ls.args, ["ls-tree", "-r", "-t", "main"]);
});

test("readFile returns content + sha, 404 when the path is absent", async () => {
  const { p } = provider((args) => {
    if (args[0] === "rev-parse") return ok("blobsha9\n");
    if (args[0] === "cat-file") return ok("<!doctype html>");
    return fail();
  });
  const f = await p.readFile(repo, "index.html", "main");
  assert.deepEqual(f, { content: "<!doctype html>", sha: "blobsha9", encoding: "utf-8" });

  const missing = provider((args) =>
    args[0] === "rev-parse" ? fail(1) : fail(),
  );
  await assert.rejects(
    () => missing.p.readFile(repo, "nope.txt", "main"),
    (e) => e instanceof GitError && e.status === 404,
  );
});

test("archive shells git archive --format=zip and returns bytes", async () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
  const { p, calls } = provider((args) => {
    if (args[0] === "symbolic-ref") return ok("main\n");
    if (args[0] === "archive") return { code: 0, stdout: zip };
    return fail();
  });
  const r = await p.archive(repo);
  assert.equal(r.filename, "site.zip");
  assert.deepEqual([...r.data], [...zip]);
  assert.deepEqual(calls.find((c) => c.args[0] === "archive")!.args, [
    "archive",
    "--format=zip",
    "main",
  ]);
});

test("writeFile (create) hashes, builds a tree, parent-less commit, CAS create", async () => {
  const { p, calls } = provider((args) => {
    if (args[0] === "rev-parse") return fail(1); // no current blob AND unborn branch
    if (args[0] === "hash-object") return ok("newblob\n");
    if (args[0] === "write-tree") return ok("newtree\n");
    if (args[0] === "commit-tree") return ok("newcommit\n");
    if (args[0] === "update-ref") return ok();
    return ok();
  });
  const r = await p.writeFile(repo, {
    path: "index.html",
    content: "hi",
    branch: "main",
    message: "add index",
  });
  assert.deepEqual(r, { commitSha: "newcommit", sha: "newblob" });

  const hash = calls.find((c) => c.args[0] === "hash-object")!;
  assert.deepEqual(hash.args, ["hash-object", "-w", "--stdin"]);
  assert.equal(hash.input?.toString("utf-8"), "hi");

  // unborn branch → no -p, and CAS old-value is "" (create-only)
  const commit = calls.find((c) => c.args[0] === "commit-tree")!;
  assert.deepEqual(commit.args, ["commit-tree", "newtree", "-m", "add index"]);
  const ref = calls.find((c) => c.args[0] === "update-ref")!;
  assert.deepEqual(ref.args, ["update-ref", "refs/heads/main", "newcommit", ""]);

  // staged via a throwaway index, not the repo's real one
  const upd = calls.find((c) => c.args[0] === "update-index")!;
  assert.equal(upd.env?.GIT_INDEX_FILE, "index-test");
});

test("writeFile (update) reads parent tree and CAS-guards on the old commit", async () => {
  const { p, calls } = provider((args, opts) => {
    if (args[0] === "rev-parse") {
      // blobShaAt(<branch>:<path>) → existing sha; branchCommit → parent
      if (args[3]?.includes(":")) return ok("oldblob\n");
      return ok("parentcommit\n");
    }
    if (args[0] === "read-tree") return ok();
    if (args[0] === "hash-object") return ok("newblob\n");
    if (args[0] === "write-tree") return ok("newtree\n");
    if (args[0] === "commit-tree") return ok("newcommit\n");
    if (args[0] === "update-ref") return ok();
    return ok();
  });
  const r = await p.writeFile(repo, {
    path: "index.html",
    content: "v2",
    sha: "oldblob",
    branch: "main",
  });
  assert.deepEqual(r, { commitSha: "newcommit", sha: "newblob" });
  assert.deepEqual(calls.find((c) => c.args[0] === "read-tree")!.args, ["read-tree", "parentcommit"]);
  assert.deepEqual(calls.find((c) => c.args[0] === "commit-tree")!.args, [
    "commit-tree",
    "newtree",
    "-p",
    "parentcommit",
    "-m",
    "Update index.html via Cantila",
  ]);
  assert.deepEqual(calls.find((c) => c.args[0] === "update-ref")!.args, [
    "update-ref",
    "refs/heads/main",
    "newcommit",
    "parentcommit",
  ]);
});

test("writeFile rejects a stale sha (409) before any write", async () => {
  const { p, calls } = provider((args) =>
    args[0] === "rev-parse" && args[3]?.includes(":") ? ok("currentsha\n") : ok(),
  );
  await assert.rejects(
    () =>
      p.writeFile(repo, { path: "index.html", content: "x", sha: "STALE", branch: "main" }),
    (e) => e instanceof GitError && e.status === 409,
  );
  assert.equal(calls.some((c) => c.args[0] === "hash-object"), false);
});

test("writeFile without a sha refuses to clobber an existing file (409)", async () => {
  const { p } = provider((args) =>
    args[0] === "rev-parse" && args[3]?.includes(":") ? ok("exists\n") : ok(),
  );
  await assert.rejects(
    () => p.writeFile(repo, { path: "index.html", content: "x", branch: "main" }),
    (e) => e instanceof GitError && e.status === 409,
  );
});

test("deleteFile stages a removal; 404 when the path is absent", async () => {
  const { p, calls } = provider((args) => {
    if (args[0] === "rev-parse") {
      if (args[3]?.includes(":")) return ok("delblob\n");
      return ok("parentcommit\n");
    }
    if (args[0] === "write-tree") return ok("t\n");
    if (args[0] === "commit-tree") return ok("delcommit\n");
    return ok();
  });
  const r = await p.deleteFile(repo, { path: "old.txt", sha: "delblob", branch: "main" });
  assert.deepEqual(r, { commitSha: "delcommit" });
  assert.deepEqual(calls.find((c) => c.args[0] === "update-index")!.args, [
    "update-index",
    "--force-remove",
    "old.txt",
  ]);

  const missing = provider((args) =>
    args[0] === "rev-parse" && args[3]?.includes(":") ? fail(1) : ok(),
  );
  await assert.rejects(
    () => missing.p.deleteFile(repo, { path: "ghost", sha: "x", branch: "main" }),
    (e) => e instanceof GitError && e.status === 404,
  );
});

test("createRepo is idempotent and returns the canonical clone URL", async () => {
  // already exists → no init, no mkdir
  const present = provider(() => ok(), true);
  const r1 = await present.p.createRepo({ owner: "acme", name: "site" });
  assert.deepEqual(r1, {
    cloneUrl: "https://git.cantila.app/acme/site.git",
    defaultBranch: "main",
  });
  assert.equal(present.calls.some((c) => c.args[0] === "init"), false);
  assert.deepEqual(present.ensured, []);

  // absent → init --bare under the owner dir
  const fresh = provider(() => ok(), false);
  await fresh.p.createRepo({ owner: "acme", name: "site" });
  const init = fresh.calls.find((c) => c.args[0] === "init")!;
  assert.deepEqual(init.args, ["init", "--bare", "--initial-branch=main", REPO_DIR]);
  assert.deepEqual(fresh.ensured, [OWNER_DIR]);
});

test("migrateRepo bare-clones the source, injecting the auth token for https", async () => {
  const fresh = provider((args) => {
    if (args[0] === "symbolic-ref") return ok("main\n");
    return ok();
  }, false);
  await fresh.p.migrateRepo({
    owner: "acme",
    name: "site",
    cloneAddr: "https://github.com/acme/site.git",
    authToken: "ghp_x",
  });
  const clone = fresh.calls.find((c) => c.args[0] === "clone")!;
  assert.deepEqual(clone.args, [
    "clone",
    "--bare",
    "https://oauth2:ghp_x@github.com/acme/site.git",
    REPO_DIR,
  ]);

  // already present → no clone
  const present = provider(() => ok("main\n"), true);
  await present.p.migrateRepo({
    owner: "acme",
    name: "site",
    cloneAddr: "https://github.com/acme/site.git",
  });
  assert.equal(present.calls.some((c) => c.args[0] === "clone"), false);
});
