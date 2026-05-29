/* ============================================================
   Owner-account boot seed (plan §18 — Option B tenancy).

   Makes a configured email a real OWNER of a real Account, rather
   than letting it fall through to the `acc_demo` DEFAULT_ACCOUNT_ID.
   Without this, a self-registered user gets NO membership, so
   `mintSession` finds nothing in `listMembershipsByUser(...)` and the
   session resolves to the demo account — the Console then shows
   "Demo Account" for the platform owner.

   Called at boot (and safe to call against a live process) — every
   step is idempotent, keyed on the account id, the user email and the
   (account,user) membership pair. The plaintext password is supplied
   by the caller from the environment (CANTILA_OWNER_PASSWORD); it is
   never read or stored here in plaintext — only its scrypt hash lands
   in the store.
   ============================================================ */

import type { Store } from "./store";
import type { AccountPlan } from "./types";
import { hashPassword } from "../auth/passwords";
import { id, now } from "../lib/ids";

export interface OwnerSeedInput {
  email: string;
  password: string;
  name?: string;
  accountId: string;
  accountName: string;
  handle: string;
  plan: AccountPlan;
}

export interface OwnerSeedResult {
  accountId: string;
  userId: string;
  created: {
    account: boolean;
    user: boolean;
    membership: boolean;
    passwordSet: boolean;
  };
}

/** Ensure `email` is an owner of account `accountId`. Idempotent. */
export async function seedOwnerAccount(
  store: Store,
  input: OwnerSeedInput,
): Promise<OwnerSeedResult> {
  const email = input.email.trim().toLowerCase();
  const created = {
    account: false,
    user: false,
    membership: false,
    passwordSet: false,
  };

  // 1. Account — create if absent.
  let account = await store.getAccount(input.accountId);
  if (!account) {
    account = await store.createAccount({
      id: input.accountId,
      name: input.accountName,
      handle: input.handle.trim().toLowerCase(),
      plan: input.plan,
      createdAt: now(),
    });
    created.account = true;
  }

  // 2. User — create if absent; backfill the password if a pre-existing
  //    (e.g. SSO-only or auto-registered) row has none.
  let user = await store.findUserByEmail(email);
  if (!user) {
    user = await store.createUser({
      id: id("usr"),
      email,
      name: input.name?.trim() || email.split("@")[0],
      passwordHash: hashPassword(input.password),
      twoFactorEnabled: false,
      emailVerifiedAt: now(),
      createdAt: now(),
    });
    created.user = true;
    created.passwordSet = true;
  } else if (!user.passwordHash) {
    user = await store.updateUserPassword(
      user.id,
      hashPassword(input.password),
    );
    created.passwordSet = true;
  }

  // 3. Membership — bind the user to the account as owner if not already.
  const existingMembership = await store.findMembership(
    user.id,
    input.accountId,
  );
  if (!existingMembership) {
    await store.createMembership({
      id: id("mem"),
      userId: user.id,
      accountId: input.accountId,
      role: "owner",
      createdAt: now(),
    });
    created.membership = true;
  }

  return { accountId: input.accountId, userId: user.id, created };
}
