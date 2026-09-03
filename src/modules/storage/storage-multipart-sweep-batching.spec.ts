import { S3Client } from "@aws-sdk/client-s3";
import { clearRegionRegistry } from "../../common/region/region-registry";
import type { MediaCompressionService } from "../../common/media/media-compression.service";
import { StorageService, type StorageConfig } from "./storage.service";
import { StorageMultipartService } from "./storage-multipart.service";

/*
 * The abandoned-multipart sweep used to cost one outbound call PER ORGANISATION.
 *
 * `CronStorageSweepService` drives it from inside `forEachOrg`, and the old
 * `sweepAbandonedUploads(orgId)` asked the object store for `Prefix: <orgId>/`, so the
 * HTTP harness measured exactly 8 outbound calls on the 8-organisation perf seed against
 * a declared `maxDownstreamCalls` of 0 — a count that grows with the tenant list on any
 * real deployment. One unprefixed list answers for the whole bucket, so the cost is now
 * one round trip per bucket plus one per pagination page.
 *
 * Nothing below reasons about S3 semantics: every command is captured off
 * `S3Client.prototype.send` and counted.
 */

const BUCKET = "default-files";
const ORG_A = "org-aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "org-bbbbbbbb-0000-4000-8000-000000000002";
const ORG_C = "org-cccccccc-0000-4000-8000-000000000003";
const STRANGER = "org-dddddddd-0000-4000-8000-000000000004";

const config = {
  R2_REGION: "auto",
  R2_BUCKET_NAME: BUCKET,
  R2_ACCESS_KEY_ID: "test-key",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_ENDPOINT: "https://default.r2.example",
  NEXT_PUBLIC_R2_PUBLIC_URL: "https://files.example",
} satisfies StorageConfig;

const DAY_MS = 24 * 60 * 60 * 1000;
const abandoned = new Date(Date.now() - 3 * DAY_MS);
const fresh = new Date(Date.now() - 60_000);

interface Sent {
  command: string;
  bucket: string;
  prefix: string | undefined;
  key: string;
}

function captureS3(uploads: Array<{ Key: string; UploadId: string; Initiated: Date }>): Sent[] {
  const sent: Sent[] = [];
  jest.spyOn(S3Client.prototype, "send").mockImplementation(async (cmd: unknown) => {
    const command = (cmd as { constructor: { name: string } }).constructor.name;
    const input = (cmd as { input: Record<string, unknown> }).input;
    const prefix = input["Prefix"];
    sent.push({
      command,
      bucket: String(input["Bucket"] ?? ""),
      prefix: typeof prefix === "string" ? prefix : undefined,
      key: String(input["Key"] ?? ""),
    });
    if (command === "ListMultipartUploadsCommand") return { Uploads: uploads };
    return {};
  });
  return sent;
}

function build(): StorageMultipartService {
  return new StorageMultipartService(new StorageService({} as MediaCompressionService, config));
}

function counts(sent: Sent[], command: string): Sent[] {
  return sent.filter((s) => s.command === command);
}

beforeEach(() => {
  clearRegionRegistry();
  jest.restoreAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
  clearRegionRegistry();
});

describe("StorageMultipartService.sweepAbandonedUploadsForOrgs — one list per bucket, not per org", () => {
  it("asks the object store ONCE for three organisations sharing a bucket", async () => {
    const sent = captureS3([]);

    const aborted = await build().sweepAbandonedUploadsForOrgs([ORG_A, ORG_B, ORG_C]);

    expect(counts(sent, "ListMultipartUploadsCommand")).toHaveLength(1);
    expect(counts(sent, "ListMultipartUploadsCommand")[0]?.bucket).toBe(BUCKET);
    expect(aborted).toBe(0);
  });

  it("drops the per-org Prefix, because the whole bucket is being reconciled at once", async () => {
    const sent = captureS3([]);

    await build().sweepAbandonedUploadsForOrgs([ORG_A, ORG_B]);

    expect(counts(sent, "ListMultipartUploadsCommand")[0]?.prefix).toBeUndefined();
  });

  it("aborts a stale upload for every swept organisation", async () => {
    const sent = captureS3([
      { Key: `${ORG_A}/uploads/a.bin`, UploadId: "u-a", Initiated: abandoned },
      { Key: `${ORG_B}/uploads/b.bin`, UploadId: "u-b", Initiated: abandoned },
    ]);

    const aborted = await build().sweepAbandonedUploadsForOrgs([ORG_A, ORG_B]);

    expect(aborted).toBe(2);
    expect(counts(sent, "AbortMultipartUploadCommand").map((s) => s.key).sort()).toEqual([
      `${ORG_A}/uploads/a.bin`,
      `${ORG_B}/uploads/b.bin`,
    ]);
  });

  it("leaves an upload belonging to an organisation this sweep did not enumerate", async () => {
    // The per-org Prefix used to make this impossible by construction. Dropping the
    // prefix without keeping the filter would abort a soft-deleted or unplaced
    // organisation's in-flight upload, which no caller ever asked for.
    const sent = captureS3([
      { Key: `${STRANGER}/uploads/theirs.bin`, UploadId: "u-x", Initiated: abandoned },
      { Key: `${ORG_A}/uploads/mine.bin`, UploadId: "u-a", Initiated: abandoned },
    ]);

    const aborted = await build().sweepAbandonedUploadsForOrgs([ORG_A]);

    expect(aborted).toBe(1);
    expect(counts(sent, "AbortMultipartUploadCommand").map((s) => s.key)).toEqual([
      `${ORG_A}/uploads/mine.bin`,
    ]);
  });

  it("leaves an upload that has no organisation segment at all", async () => {
    const sent = captureS3([
      { Key: "loose-object.bin", UploadId: "u-loose", Initiated: abandoned },
    ]);

    const aborted = await build().sweepAbandonedUploadsForOrgs([ORG_A]);

    expect(aborted).toBe(0);
    expect(counts(sent, "AbortMultipartUploadCommand")).toHaveLength(0);
  });

  it("leaves an upload that is still inside the abandonment window", async () => {
    const sent = captureS3([
      { Key: `${ORG_A}/uploads/in-flight.bin`, UploadId: "u-new", Initiated: fresh },
    ]);

    const aborted = await build().sweepAbandonedUploadsForOrgs([ORG_A]);

    expect(aborted).toBe(0);
    expect(counts(sent, "AbortMultipartUploadCommand")).toHaveLength(0);
  });

  it("makes no outbound call at all when no organisation was swept", async () => {
    const sent = captureS3([]);

    const aborted = await build().sweepAbandonedUploadsForOrgs([]);

    expect(sent).toHaveLength(0);
    expect(aborted).toBe(0);
  });
});
