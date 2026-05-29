/** The platform owner account id — the real account seeded at boot
 *  (see seed-owner / seed-platform). Internal workers (the agent brain,
 *  MCP default tools, the uptime sweep) target this instead of a demo
 *  account. Reads CANTILA_OWNER_ACCOUNT_ID, defaulting to the dedicated
 *  "acc_cantila" owner account. */
export function ownerAccountId(): string {
  return process.env.CANTILA_OWNER_ACCOUNT_ID ?? "acc_cantila";
}
