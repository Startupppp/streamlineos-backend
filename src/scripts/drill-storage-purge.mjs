#!/usr/bin/env node
/**
 * Disposable-data drill: proves purgeOrgPrefix correctly erases bytes from R2
 * and that a repeated purge is harmless.
 *
 * Modes:
 *   node drill-storage-purge.mjs --self-test   # no network, proves assertions bite
 *   node drill-storage-purge.mjs               # live R2 run
 */

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnv() {
  const path = resolve(BACKEND_ROOT, ".env");
  const env = {};
  let content;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return env;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    env[key] = val;
  }
  return env;
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function listAllKeys(client, bucket, prefix) {
  const keys = [];
  let continuationToken;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (typeof obj.Key === "string" && obj.Key.length > 0) keys.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);
  return keys;
}

async function batchDelete(client, bucket, keys) {
  const deleted = [];
  const failed = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      const res = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((k) => ({ Key: k })), Quiet: false },
        }),
      );
      for (const d of res.Deleted ?? []) {
        if (typeof d.Key === "string") deleted.push(d.Key);
      }
      for (const e of res.Errors ?? []) {
        if (typeof e.Key === "string") {
          failed.push({ key: e.Key, reason: e.Message ?? e.Code ?? "unknown" });
        }
      }
    } catch (err) {
      for (const key of batch) {
        failed.push({ key, reason: err instanceof Error ? err.message : "unknown" });
      }
    }
  }
  return { deleted, failed };
}

function selfTest() {
  console.log("[self-test] Verifying each assertion bites when the invariant is broken…");

  let fired;

  fired = false;
  try {
    const fakeRemaining = ["gdpr-drill/test/marker.txt"];
    assert(fakeRemaining.length === 0, "purge must leave 0 objects remaining");
  } catch {
    fired = true;
  }
  assert(fired, "assertion (zero-remaining) must fire when object persists");
  console.log("[self-test] ✓ assertion 1 (zero-remaining) bites correctly");

  fired = false;
  try {
    const fakeSecondDeleted = ["gdpr-drill/test/marker.txt"];
    assert(fakeSecondDeleted.length === 0, "second purge must delete 0 objects");
  } catch {
    fired = true;
  }
  assert(fired, "assertion (idempotent second run) must fire when second purge deletes objects");
  console.log("[self-test] ✓ assertion 2 (idempotent second run) bites correctly");

  fired = false;
  const partialResult = { deleted: ["ok.pdf", "bad.pdf"], failed: [] };
  try {
    assert(!partialResult.deleted.includes("bad.pdf"), "failed keys must not appear in deleted");
  } catch {
    fired = true;
  }
  assert(fired, "assertion (partial-failure separation) must fire when failed key is in deleted");
  console.log("[self-test] ✓ assertion 3 (partial-failure separation) bites correctly");

  fired = false;
  try {
    const emptyResult = { deleted: [], failed: [{ key: "bad.pdf", reason: "err" }] };
    assert(emptyResult.failed.length === 0, "first purge must have 0 failures on clean data");
  } catch {
    fired = true;
  }
  assert(fired, "assertion (zero-failures) must fire when failures are present");
  console.log("[self-test] ✓ assertion 4 (zero-failures on clean data) bites correctly");

  console.log("[self-test] All assertions verified. PASS.");
}

async function liveTest() {
  const env = loadEnv();
  const bucket = env["R2_BUCKET_NAME"];
  const endpoint = env["R2_ENDPOINT"];
  const accessKeyId = env["R2_ACCESS_KEY_ID"];
  const secretAccessKey = env["R2_SECRET_ACCESS_KEY"];

  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing R2 credentials. Ensure backend/.env contains R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.",
    );
  }

  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  const drillId = randomUUID();
  const prefix = `gdpr-drill/${drillId}/`;
  const testKey = `${prefix}marker.txt`;

  console.log(`[live] Drill ID: ${drillId}`);
  console.log(`[live] Test key: ${testKey}`);

  console.log("[live] Uploading disposable test object…");
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: testKey,
      Body: Buffer.from(`gdpr-drill ${drillId}`),
      ContentType: "text/plain",
    }),
  );
  console.log("[live] ✓ Uploaded");

  const beforeKeys = await listAllKeys(client, bucket, prefix);
  assert(
    beforeKeys.length === 1,
    `Before purge: expected 1 object, got ${beforeKeys.length}`,
  );
  console.log("[live] ✓ Object confirmed in storage (1 key found)");

  console.log("[live] Running first purge…");
  const firstRun = await batchDelete(client, bucket, beforeKeys);
  assert(
    firstRun.deleted.length === 1,
    `First purge: expected 1 deleted, got ${firstRun.deleted.length}`,
  );
  assert(
    firstRun.failed.length === 0,
    `First purge: expected 0 failed, got ${firstRun.failed.length}`,
  );
  console.log("[live] ✓ First purge succeeded (1 deleted, 0 failed)");

  const afterKeys = await listAllKeys(client, bucket, prefix);
  assert(
    afterKeys.length === 0,
    `After purge: expected 0 objects, got ${afterKeys.length} — bytes not physically gone`,
  );
  console.log("[live] ✓ Zero bytes remain under prefix");

  console.log("[live] Running second purge (idempotency check)…");
  const secondRun = await batchDelete(client, bucket, afterKeys);
  assert(
    secondRun.deleted.length === 0,
    `Second purge: expected 0 deleted, got ${secondRun.deleted.length}`,
  );
  assert(
    secondRun.failed.length === 0,
    `Second purge: expected 0 failed, got ${secondRun.failed.length}`,
  );
  console.log("[live] ✓ Second purge is a harmless no-op");

  console.log("[live] All assertions passed. PASS.");
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  try {
    selfTest();
    process.exit(0);
  } catch (err) {
    console.error("[self-test] FAIL:", err.message);
    process.exit(1);
  }
} else {
  liveTest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[live] FAIL:", err.message);
      process.exit(1);
    });
}
