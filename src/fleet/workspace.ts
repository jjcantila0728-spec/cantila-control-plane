import path from "node:path";

/** Absolute workspace dir for a project: <root>/<projectId>/workspace.
 *  Rejects a projectId that would escape the root (separators, drive letters,
 *  traversal) — defence-in-depth even though ids are server-generated. */
export function workspaceDir(root: string, projectId: string): string {
  const dir = path.resolve(root, projectId, "workspace");
  const rel = path.relative(path.resolve(root), path.resolve(root, projectId));
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`invalid projectId: ${projectId}`);
  }
  return dir;
}

/** Resolve a caller-supplied relative path inside the workspace, refusing any
 *  path that escapes it (traversal or absolute). A file literally named "..foo"
 *  is allowed; only true parent escapes are rejected. */
export function resolveInWorkspace(ws: string, relPath: string): string {
  const abs = path.resolve(ws, relPath);
  const rel = path.relative(ws, abs);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`path outside workspace: ${relPath}`);
  }
  return abs;
}
