import { createHash } from "node:crypto";
import { validateMagicBytes } from "../storage/file-signatures";
import type { StorageService } from "../storage/storage.service";
import type { FileQuarantineService } from "../storage/file-quarantine.service";
import type { AvScanner } from "../../common/security/av-scan";
import { logger } from "../../common/logger/logger.service";

/**
 * Résumé bytes arriving on the public apply form.
 *
 * Kept out of `PublicCareersService` because every decision here is about the
 * *file* — what may be uploaded by an unauthenticated stranger, where the bytes
 * land, and what we are entitled to claim about them — and none of it is about
 * the application record.
 *
 * The quarantine verdict is whatever `AvScanner` actually returned, never an
 * assumption. An infected file is refused outright; a scanner that is not
 * configured (`NoopAvScanner` in production) reports `error`, and the file is
 * then stored as unscanned rather than clean — the authenticated upload route
 * used to call `markClean` straight after storing, which is a claim no scan
 * supports and which the vault download then trusted.
 */

export const RESUME_MAX_BYTES = 10 * 1024 * 1024;

/**
 * `file_quarantine_records.uploaded_by` is NOT NULL and carries no FK, so a
 * stranger's upload is recorded under a sentinel rather than a forged user id.
 * The sweep and the usage report both read this column; a real user id here
 * would attribute a public applicant's file to whoever happened to match.
 */
export const PUBLIC_APPLICANT = "public:careers-apply";

export const RESUME_ALLOWED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

const EXTENSION_FOR_TYPE = /\.(pdf|docx|doc)$/i;

export interface ResumeUpload {
  readonly buffer: Buffer;
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
}

export type ResumeRejection =
  | "too-large"
  | "type-not-allowed"
  | "content-mismatch"
  | "infected";

export type ResumeIntake =
  | { stored: false; reason: "no-file" | "storage-not-configured" | "upload-failed" | ResumeRejection }
  | {
      stored: true;
      key: string;
      filename: string;
      fileType: string;
      fileSize: number;
      quarantineId: string;
      /** What the scanner said. `PENDING` means nothing scanned it. */
      avResult: "CLEAN" | "PENDING";
    };

export function refuseResume(file: ResumeUpload): ResumeRejection | null {
  if (file.size > RESUME_MAX_BYTES) return "too-large";
  if (!RESUME_ALLOWED_TYPES.includes(file.mimetype as (typeof RESUME_ALLOWED_TYPES)[number]))
    return "type-not-allowed";
  if (!EXTENSION_FOR_TYPE.test(file.originalname)) return "type-not-allowed";
  if (!validateMagicBytes(file.buffer, file.mimetype)) return "content-mismatch";
  return null;
}

export const RESUME_REJECTION_MESSAGE: Record<ResumeRejection, string> = {
  "too-large": "Résumé must be 10MB or smaller.",
  "type-not-allowed": "Résumé must be a PDF, DOC or DOCX file.",
  "content-mismatch": "That file's contents do not match its type.",
  infected: "That file was refused by malware scanning.",
};

/**
 * Stores the bytes and opens a quarantine record, before the application
 * transaction runs.
 *
 * Object storage is a network call, so it happens outside the transaction
 * rather than holding a pooled connection open across someone else's outage
 * (backend CLAUDE.md §4). The cost is that a rolled-back application can leave
 * an orphaned object; the quarantine row is what makes that object findable.
 */
export async function storeResume(
  storage: StorageService,
  quarantine: FileQuarantineService,
  scanner: AvScanner,
  orgId: string,
  file: ResumeUpload,
): Promise<ResumeIntake> {
  if (!storage.isConfigured()) return { stored: false, reason: "storage-not-configured" };

  /**
   * Scanned before a byte is written, so an infected résumé never reaches the
   * bucket at all. A scanner `error` is not a refusal here — unlike the
   * authenticated upload route, refusing would mean a candidate cannot apply
   * because the operator has not configured ClamAV — but it does mean the file
   * is recorded unscanned, and the vault download refuses anything not CLEAN.
   */
  const verdict = await scanner.scan(file.buffer, file.originalname, file.mimetype);
  if (verdict.status === "infected") return { stored: false, reason: "infected" };

  try {
    const { key } = await storage.planUpload(
      orgId,
      file.buffer,
      "candidates/resumes",
      file.originalname,
      file.mimetype,
    );
    const quarantineId = await quarantine.begin({
      orgId,
      storageKey: key,
      filename: file.originalname,
      mimeType: file.mimetype,
      fileSizeBytes: file.size,
      sha256: createHash("sha256").update(file.buffer).digest("hex"),
      uploadedBy: PUBLIC_APPLICANT,
    });
    await storage.uploadToKey(orgId, file.buffer, key, file.mimetype);
    await quarantine.recordMeasuredObject(quarantineId, {
      fileSizeBytes: file.size,
      mimeType: file.mimetype,
    });
    if (verdict.status === "clean") await quarantine.markClean(quarantineId);
    else await quarantine.markError(quarantineId);
    return {
      stored: true,
      key,
      filename: file.originalname,
      fileType: file.mimetype,
      fileSize: file.size,
      quarantineId,
      avResult: verdict.status === "clean" ? "CLEAN" : "PENDING",
    };
  } catch (error) {
    /**
     * A storage outage must not cost the candidate their application. The
     * response says the résumé was not kept, so neither the candidate nor the
     * recruiter is told a file exists that does not.
     */
    logger.error("[public-careers] résumé upload failed; application continues without it", {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { stored: false, reason: "upload-failed" };
  }
}
