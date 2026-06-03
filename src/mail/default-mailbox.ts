/* ============================================================
   Canonical auto-wired transactional mailbox for a project.

   Every project's default inbox is `info@<slug>.cantila.app` — the
   same subdomain its site is served from (`<slug>.cantila.app`,
   see deploy pipeline / plan §7.4). Keeping mail on the project's
   own owned-domain subdomain (cantila.app) means one consistent
   identity for both web and email, and avoids the earlier fictional
   `*.send.cantila.email` domain (cantila.email is not owned).

   Single source of truth: the stub provisioner uses this on first
   deploy, and the boot reconcile rewrites legacy rows to match it.
   ============================================================ */

export interface DefaultMailbox {
  address: string;
  sendingDomain: string;
  smtpHost: string;
  smtpUser: string;
}

/** The canonical default mailbox for a project slug. */
export function defaultProjectMailbox(slug: string): DefaultMailbox {
  const sendingDomain = `${slug}.cantila.app`;
  const address = `info@${sendingDomain}`;
  return {
    address,
    sendingDomain,
    smtpHost: "mail.cantila.app",
    // SMTP submission authenticates with the full mailbox address —
    // the convention real MTAs (Mailcow) expect.
    smtpUser: address,
  };
}

/** True when a persisted mailbox already matches the canonical scheme
 *  for its project — used by the reconcile to skip no-op writes. */
export function isCanonicalMailbox(
  mb: { address: string; sendingDomain: string },
  slug: string,
): boolean {
  const want = defaultProjectMailbox(slug);
  return mb.address === want.address && mb.sendingDomain === want.sendingDomain;
}
