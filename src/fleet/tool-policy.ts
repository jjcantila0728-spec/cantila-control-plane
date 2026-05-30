/* Shared Claude Code tool policy for fleet sessions (build + remediation).
   Sessions run permissionMode:"dontAsk" with these lists. The deny-list is
   defense-in-depth on top of the per-project cwd sandbox: it blocks shell
   commands that could mutate prod / exfiltrate / escape the workspace. */

export const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"];

export const DISALLOWED_BASH = [
  "Bash(rm:*)", "Bash(sudo:*)", "Bash(mv:*)", "Bash(chmod:*)", "Bash(chown:*)",
  "Bash(git push:*)", "Bash(git clone:*)", "Bash(git reset:*)",
  "Bash(docker:*)", "Bash(kubectl:*)", "Bash(npm publish:*)",
  "Bash(ssh:*)", "Bash(scp:*)", "Bash(curl:*)", "Bash(wget:*)",
];
