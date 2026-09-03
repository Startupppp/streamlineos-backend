import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

/**
 * The response half of the storage contract.
 *
 * Each schema is derived from the service projection or the declared return type it
 * describes — named above it — and never from a client's hand-written interface.
 * `ResponseContractInterceptor` compares them against the value the handler actually
 * returned on every request under `NODE_ENV=test`.
 *
 * Storage is the surface where a wrong contract costs the most: three of these
 * responses carry a signed URL or an object key, so a schema that quietly widened
 * would be a schema that stopped noticing one appearing where it should not. The
 * schemas are therefore written CLOSED over the fields that matter — `signedUrl` and
 * `downloadUrl` are declared `string | null` rather than `unknown` — and every
 * violation report carries paths and issue codes only, never the value.
 *
 * NOT `.strict()`, for the same reason as the calendar set: an added response field is
 * a backward-compatible deploy, and a removed/renamed/retyped one is already rejected.
 */

/** `StorageService.UploadJobResult` — `POST /storage/upload`. */
export const storageUploadResponseSchema = z.object({
  quarantineId: z.string(),
  status: z.literal("pending_scan"),
  key: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});

/** `StorageMultipartService.initiate` plus the quarantine row opened beside it. */
export const multipartInitiateResponseSchema = z.object({
  uploadId: z.string(),
  key: z.string(),
  partUrls: z.array(
    z.object({ partNumber: z.number().int().positive(), url: z.string() }),
  ),
  quarantineId: z.string(),
});

/**
 * `POST /storage/multipart/complete` — both arms.
 * The replay arm returns the EXISTING record's status, which is any terminal
 * quarantine status; the fresh arm always returns `pending_scan`. One schema covering
 * both is what makes the replay path contract-checked rather than only the happy one.
 */
export const multipartCompleteResponseSchema = z.object({
  quarantineId: z.string(),
  key: z.string(),
  status: z.enum(["pending_scan", "clean", "infected", "error"]),
  replayed: z.boolean(),
});

export const multipartAbortResponseSchema = z.object({ aborted: z.boolean() });

/** `FileQuarantineService.QuarantineRecord` — the explicit twelve-column projection. */
export const quarantineRecordSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  storageKey: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  fileSizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  status: z.enum(["pending_scan", "clean", "infected", "error"]),
  threatName: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  uploadedBy: z.string(),
  createdAt: wireDate(),
});

/** `CursorPage<QuarantineRecord>` — `common/pagination/cursor.ts`. */
export const quarantineListResponseSchema = z.object({
  data: z.array(quarantineRecordSchema),
  pagination: z.object({
    limit: z.number().int().positive(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});

export const quarantineStatusResponseSchema = z.object({
  status: z.enum(["clean", "infected"]),
});

export const quarantineDeleteResponseSchema = z.object({ deleted: z.boolean() });

/** `StorageOnboardingController.upload`. */
export const onboardingDocumentResponseSchema = z.object({ url: z.string() });

/**
 * `VaultDownloadResponse` — `storage-vault.controller.ts:37`.
 * `createdAt` is a `Date` and `expiresAt` a pre-formatted string: the two timestamps
 * on one response are carried differently, which the declared interface says and no
 * consumer could have discovered. Recorded as it is.
 */
export const vaultDownloadResponseSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  filename: z.string(),
  fileType: z.string(),
  fileSize: z.number().int().nonnegative(),
  documentType: z.string().nullable(),
  avResult: z.enum(["PENDING", "CLEAN", "INFECTED"]),
  expiresAt: z.string().nullable(),
  createdAt: wireDate(),
  signedUrl: z.string().nullable(),
});

/** `AttachmentResponse[]` — `storage-kb.controller.ts:46`. A PUBLIC route. */
export const kbAttachmentListResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    fileName: z.string(),
    fileSize: z.number().int().nonnegative(),
    mimeType: z.string(),
    createdAt: wireDate(),
    downloadUrl: z.string().nullable(),
  }),
);

/**
 * `CronStorageSweepService.StorageSweepResult`, under the controller's own
 * `{ success: true, ... }` envelope, plus the lease-skip arm.
 *
 * Every counter is declared as an integer rather than left open, because the failure
 * this guards is a counter that stops being assigned: `result.organizations` is written
 * once, after `forEachOrg` returns, and a sweep that threw past that point would report
 * `undefined` while still answering 200. That is precisely a wrong-but-plausible
 * response — the shape the whole response-contract effort exists to catch.
 */
export const storageSweepResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    skipped: z.literal(true),
    message: z.string(),
  }),
  z.object({
    success: z.literal(true),
    organizations: z.number().int().nonnegative(),
    multipartAborted: z.number().int().nonnegative(),
    quarantineExpired: z.number().int().nonnegative(),
    s3ObjectsDeleted: z.number().int().nonnegative(),
    deleteFailures: z.number().int().nonnegative(),
    pendingPurgeConfirmed: z.number().int().nonnegative(),
    pendingPurgeFailed: z.number().int().nonnegative(),
    pendingPurgeSkipped: z.number().int().nonnegative(),
  }),
]);
