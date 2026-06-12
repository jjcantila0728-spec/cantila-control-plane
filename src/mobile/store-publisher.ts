/* ============================================================
   StorePublisher — submit a finished mobile build to an app
   store under Cantila's developer accounts. Spec 2026-06-11 §4.

   - GooglePlayPublisher: LIVE when GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
     holds the Play Console service-account JSON. Talks straight to
     the androidpublisher v3 REST API — OAuth token minted from an
     RS256 JWT signed with node:crypto, so no googleapis dependency.
     Flow: insert edit → upload bundle/apk → assign track → commit.
   - StubGooglePlayPublisher: default; records the release as
     `stubbed` and tells the operator which env var goes live.
   - AppStoreComingSoonPublisher: permanent port for Apple. Binary
     upload needs macOS Transporter, and the Cantila Apple developer
     account doesn't exist yet — publish() throws a typed
     coming-soon error the API maps to a friendly 409. The
     APPSTORE_CONNECT_* env contract is reserved here so go-live is
     an adapter fill-in, not a redesign.
   ============================================================ */

import { createSign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { StoreKind } from "../domain/types";

export type { StoreKind };

export interface PublishInput {
  applicationId: string;
  artifactPath: string;
  artifactKind: "aab" | "apk";
  /** Play track: internal | alpha | beta | production. */
  track: string;
  versionCode: number;
}

export interface PublishResult {
  status: "published" | "stubbed";
  /** Provider-side reference (Play edit id). */
  externalRef?: string;
  message: string;
}

export interface StorePublisher {
  store: StoreKind;
  label: string;
  live: boolean;
  publish(input: PublishInput): Promise<PublishResult>;
}

export class AppStoreComingSoonError extends Error {
  constructor() {
    super(
      "App Store publishing is coming soon — Cantila's Apple developer account is being set up. Google Play publishing is available today.",
    );
    this.name = "AppStoreComingSoonError";
  }
}

/* ----- Google Play ----- */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const PLAY_UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

const b64url = (data: string | Buffer) =>
  Buffer.from(data).toString("base64url");

export class GooglePlayPublisher implements StorePublisher {
  store: StoreKind = "google_play";
  label = "google-play";
  live = true;

  private account: ServiceAccount;
  private fetchImpl: typeof fetch;

  constructor(serviceAccountJson: string, fetchImpl: typeof fetch = fetch) {
    this.account = JSON.parse(serviceAccountJson) as ServiceAccount;
    this.fetchImpl = fetchImpl;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = await this.accessToken();
    const auth = { Authorization: `Bearer ${token}` };
    const base = `${PLAY_API}/applications/${input.applicationId}`;

    // 1. open an edit (a transactional staging area for the release)
    const edit = (await this.json(
      `${base}/edits`,
      { method: "POST", headers: auth },
    )) as { id: string };

    // 2. upload the binary
    const endpoint = input.artifactKind === "apk" ? "apks" : "bundles";
    const bytes = await readFile(input.artifactPath);
    await this.json(
      `${PLAY_UPLOAD}/applications/${input.applicationId}/edits/${edit.id}/${endpoint}?uploadType=media`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bytes),
      },
    );

    // 3. assign the uploaded versionCode to the requested track
    await this.json(`${base}/edits/${edit.id}/tracks/${input.track}`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        track: input.track,
        releases: [
          { versionCodes: [String(input.versionCode)], status: "completed" },
        ],
      }),
    });

    // 4. commit — this is the moment the release actually submits
    await this.json(`${base}/edits/${edit.id}:commit`, {
      method: "POST",
      headers: auth,
    });

    return {
      status: "published",
      externalRef: edit.id,
      message: `Released versionCode ${input.versionCode} to the ${input.track} track on Google Play.`,
    };
  }

  /** Service-account OAuth: RS256 JWT → access token. */
  private async accessToken(): Promise<string> {
    const tokenUri = this.account.token_uri ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: this.account.client_email,
        scope: PLAY_SCOPE,
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
        jti: randomUUID(),
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(this.account.private_key).toString("base64url");
    const jwt = `${header}.${claims}.${signature}`;

    const result = (await this.json(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
    })) as { access_token: string };
    return result.access_token;
  }

  private async json(url: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        /* non-JSON error body — keep the raw slice */
      }
      throw new Error(`Google Play API ${res.status}: ${message}`);
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }
}

export class StubGooglePlayPublisher implements StorePublisher {
  store: StoreKind = "google_play";
  label = "google-play-stub";
  live = false;

  async publish(input: PublishInput): Promise<PublishResult> {
    return {
      status: "stubbed",
      message: `Release recorded (versionCode ${input.versionCode} → ${input.track}); Google Play publisher is offline. Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON to the Play Console service-account JSON to publish for real.`,
    };
  }
}

/* ----- App Store (coming soon) ----- */

export class AppStoreComingSoonPublisher implements StorePublisher {
  store: StoreKind = "app_store";
  label = "app-store-coming-soon";
  live = false;

  /** Reserved env contract for go-live: APPSTORE_CONNECT_ISSUER_ID,
   *  APPSTORE_CONNECT_KEY_ID, APPSTORE_CONNECT_PRIVATE_KEY (ES256 .p8).
   *  Validated here once binary upload (Transporter) is implemented. */
  async publish(_input: PublishInput): Promise<PublishResult> {
    throw new AppStoreComingSoonError();
  }
}

/* ----- factory ----- */

export function createStorePublishers(
  env: Record<string, string | undefined>,
): Map<StoreKind, StorePublisher> {
  const googlePlay = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
    ? new GooglePlayPublisher(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON)
    : new StubGooglePlayPublisher();
  return new Map<StoreKind, StorePublisher>([
    ["google_play", googlePlay],
    ["app_store", new AppStoreComingSoonPublisher()],
  ]);
}
