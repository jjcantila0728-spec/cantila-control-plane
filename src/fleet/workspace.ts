import path from "node:path";

/** Absolute workspace dir for a project: <root>/<projectId>/workspace. */
export function workspaceDir(root: string, projectId: string): string {
  return path.resolve(root, projectId, "workspace");
}

/** Resolve a caller-supplied relative path inside the workspace, refusing any
 *  path that escapes it (traversal or absolute). */
export function resolveInWorkspace(ws: string, relPath: string): string {
  const abs = path.resolve(ws, relPath);
  const rel = path.relative(ws, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path outside workspace: ${relPath}`);
  }
  return abs;
}
