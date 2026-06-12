/* StorePublisher — unit tests. GooglePlayPublisher runs against a mocked
   fetch; no network, no real Play account. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppStoreComingSoonError,
  createStorePublishers,
  GooglePlayPublisher,
  StubGooglePlayPublisher,
  type PublishInput,
} from "./store-publisher";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  type: "service_account",
  client_email: "publisher@cantila-play.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
});

async function withArtifact(fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cantila-publish-"));
  try {
    const artifactPath = join(dir, "app.aab");
    await writeFile(artifactPath, "fake-aab-bytes");
    await fn(artifactPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const input = (artifactPath: string): PublishInput => ({
  applicationId: "app.cantila.demo",
  artifactPath,
  artifactKind: "aab",
  track: "internal",
  versionCode: 7,
});

test("GooglePlayPublisher walks the edits flow: token → insert → upload → track → commit", async () => {
  await withArtifact(async (artifactPath) => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetchMock: typeof fetch = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? "GET", body: init?.body });
      if (u.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "tok_123", expires_in: 3600 });
      }
      if (u.endsWith("/edits") ) {
        return Response.json({ id: "edit_42" });
      }
      if (u.includes("/bundles")) {
        return Response.json({ versionCode: 7 });
      }
      if (u.includes("/tracks/internal")) {
        return Response.json({ track: "internal" });
      }
      if (u.endsWith(":commit")) {
        return Response.json({ id: "edit_42" });
      }
      throw new Error(`unexpected call: ${u}`);
    };

    const publisher = new GooglePlayPublisher(serviceAccount, fetchMock);
    assert.equal(publisher.live, true);
    const result = await publisher.publish(input(artifactPath));

    assert.equal(result.status, "published");
    assert.equal(result.externalRef, "edit_42");
    assert.equal(calls.length, 5);
    assert.match(calls[1].url, /androidpublisher\/v3\/applications\/app\.cantila\.demo\/edits$/);
    assert.match(calls[2].url, /upload.*\/edits\/edit_42\/bundles/);
    assert.match(calls[3].url, /\/edits\/edit_42\/tracks\/internal$/);
    const trackBody = JSON.parse(String(calls[3].body)) as {
      releases: { versionCodes: string[]; status: string }[];
    };
    assert.deepEqual(trackBody.releases[0].versionCodes, ["7"]);
    assert.equal(trackBody.releases[0].status, "completed");
    assert.match(calls[4].url, /\/edits\/edit_42:commit$/);
  });
});

test("GooglePlayPublisher surfaces the Google error message on failure", async () => {
  await withArtifact(async (artifactPath) => {
    const fetchMock: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes("oauth2")) return Response.json({ access_token: "t", expires_in: 3600 });
      return new Response(
        JSON.stringify({ error: { message: "APK specifies a version code that has already been used." } }),
        { status: 400 },
      );
    };
    const publisher = new GooglePlayPublisher(serviceAccount, fetchMock);
    await assert.rejects(
      publisher.publish(input(artifactPath)),
      /version code that has already been used/,
    );
  });
});

test("stub publisher records the release without contacting Google", async () => {
  await withArtifact(async (artifactPath) => {
    const stub = new StubGooglePlayPublisher();
    assert.equal(stub.live, false);
    const result = await stub.publish(input(artifactPath));
    assert.equal(result.status, "stubbed");
    assert.match(result.message, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/);
  });
});

test("app store publisher is coming-soon", async () => {
  const publishers = createStorePublishers({});
  const appStore = publishers.get("app_store")!;
  assert.equal(appStore.live, false);
  await assert.rejects(
    appStore.publish(input("/tmp/x.ipa")),
    AppStoreComingSoonError,
  );
});

test("factory gates Google Play on the service-account env", () => {
  assert.equal(createStorePublishers({}).get("google_play")!.live, false);
  assert.equal(
    createStorePublishers({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: serviceAccount }).get("google_play")!.live,
    true,
  );
});
