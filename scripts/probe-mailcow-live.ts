/* Live Mailcow provisioner probe (operator-run, not committed to flows).
   Exercises the real MailcowMailboxProvisioner against the live box using
   MAILCOW_URL + MAILCOW_API_KEY from the environment. Creates a throwaway
   probe mailbox then deletes it, so it proves ensureDomain/createMailbox/
   deleteMailbox end-to-end without leaving an orphan.

   Run: npx tsx scripts/probe-mailcow-live.ts */
import { createMailboxProvisioner } from "../src/mail/provisioner";
import { randomBytes } from "node:crypto";

async function main() {
  const p = createMailboxProvisioner();
  console.log(`provisioner: ${p.label} (live=${p.live})`);
  if (!p.live) {
    console.error("NOT LIVE — MAILCOW_URL/MAILCOW_API_KEY not set in env");
    process.exit(1);
  }

  const probe = `zzprobe-${Date.now().toString(36)}@cantila.app`;
  const pw = randomBytes(18).toString("base64url");

  const dom = await p.ensureDomain("cantila.app");
  console.log("ensureDomain(cantila.app):", JSON.stringify(dom));
  if ("error" in dom) process.exit(1);

  const made = await p.createMailbox({
    address: probe,
    password: pw,
    quotaMb: 1024,
    displayName: "probe",
  });
  console.log(`createMailbox(${probe}):`, JSON.stringify(made));
  if ("error" in made) process.exit(1);

  const del = await p.deleteMailbox(probe);
  console.log(`deleteMailbox(${probe}):`, JSON.stringify(del));
  if ("error" in del) process.exit(1);

  console.log("PASS: live Mailcow provisioner create+delete round-trip");
}
main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
