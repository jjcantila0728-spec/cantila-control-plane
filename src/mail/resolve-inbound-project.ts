/* ============================================================
   resolveInboundProject — route an inbound recipient to its owning
   project (plan §20.11, the platform-default-mailbox follow-up).

   Two tiers, in order:
     1. Explicit HostedMailbox row — a provisioned mailbox address
        (`store.findHostedMailboxByAddress`). Covers custom mailboxes
        and adopted platform mailboxes that carry a row.
     2. Canonical platform-default scheme — every project owns its
        whole `<slug>.cantila.app` subdomain (the wildcard model,
        `*@<slug>.cantila.app`; default inbox `info@<slug>.cantila.app`,
        see `default-mailbox.ts`). When no mailbox row matches, the
        recipient's host is matched against the project's own domain
        row (`store.findDomainByHostname`) and routed to its project.

   Before this, the IMAP poller resolved only tier 1, so mail to a
   project's default `info@<slug>.cantila.app` inbox — which has no
   HostedMailbox row — was left unseen as unroutable. Pure orchestration
   over two injected store lookups; no I/O of its own.
   ============================================================ */

/** Minimal store surface this resolver needs — kept narrow so it is
 *  trivially fakeable in tests and decoupled from the full `Store`. */
export interface InboundProjectResolverDeps {
  findHostedMailboxByAddress: (
    address: string,
  ) => Promise<{ projectId: string } | null>;
  findDomainByHostname: (
    hostname: string,
  ) => Promise<{ projectId: string } | null>;
}

/** Extract the host (domain) part of an email address, lowercased and
 *  trimmed, or null when there is no usable host. Splits on the LAST
 *  `@` so a quoted local part containing `@` doesn't confuse it. */
export function hostFromAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const host = address.slice(at + 1).trim().toLowerCase();
  return host || null;
}

/** Build the recipient → projectId resolver used by the inbound mail
 *  bridge. Returns null when no project owns the address (unroutable —
 *  the poller leaves such mail unseen for a later retry). */
export function makeResolveInboundProject(
  deps: InboundProjectResolverDeps,
): (toAddress: string) => Promise<string | null> {
  return async (toAddress: string) => {
    const address = toAddress.trim().toLowerCase();

    // Tier 1: an explicit provisioned mailbox row.
    const mailbox = await deps.findHostedMailboxByAddress(address);
    if (mailbox?.projectId) return mailbox.projectId;

    // Tier 2: the project's own `<slug>.cantila.app` subdomain owns the
    // whole address space (wildcard model), including its default inbox.
    const host = hostFromAddress(address);
    if (!host) return null;
    const domain = await deps.findDomainByHostname(host);
    return domain?.projectId ?? null;
  };
}
