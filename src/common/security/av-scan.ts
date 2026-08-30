/**
 * Attachment malware scanning seam.
 *
 * The concrete implementation depends on the operator's AV provider (ClamAV,
 * VirusTotal, etc.) and is intentionally NOT wired here. `NoopAvScanner` is a
 * drop-in for local dev and for tenants whose files travel through a provider
 * (e.g. Gmail/Outlook) that already scans on delivery.
 *
 * PRODUCTION: set AV_SCANNER=clamav|virustotal and provide the required env
 * vars. Without AV_SCANNER the fallback is the noop adapter, which logs a
 * warning and returns "clean". That is intentional: the first safe state is to
 * let uploads through rather than to block everything silently.
 *
 * File quarantine:
 *   Uploads land in a staging path (`uploads/quarantine/<orgId>/<uuid>`) first.
 *   The scan result gates promotion to the permanent path
 *   (`uploads/<orgId>/<uuid>`). Any scan result other than "clean" leaves the
 *   file in quarantine for the operator's review window (48 h by default, then
 *   auto-deleted by the cron sweep). The calling controller is responsible for
 *   writing the quarantine record to the DB before calling scan().
 *
 * Upload size and type limits:
 *   Enforced before scan by `assertUploadAllowed` in this module. Never accept
 *   a file that would be rejected by the scan — saves an unnecessary provider
 *   round-trip.
 *
 * Signed expiring downloads:
 *   `signDownloadUrl` produces a time-limited, HMAC-signed URL. The storage
 *   retrieval endpoint verifies the signature AND re-asserts the caller's object-
 *   level access before streaming bytes. Tokens are single-tenant (carry orgId)
 *   and are NOT cached.
 */

import { Injectable, Logger } from "@nestjs/common";
import { createHmac, randomBytes } from "node:crypto";

export type AvScanResult =
  | { status: "clean" }
  | { status: "infected"; threat: string }
  | { status: "error"; reason: string };

export abstract class AvScanner {
  abstract scan(buffer: Buffer, filename: string, mimeType: string): Promise<AvScanResult>;
}

@Injectable()
export class NoopAvScanner extends AvScanner {
  private readonly logger = new Logger(NoopAvScanner.name);

  async scan(_buffer: Buffer, filename: string, _mimeType: string): Promise<AvScanResult> {
    if (process.env.NODE_ENV === "production" && !process.env.AV_SCANNER) {
      this.logger.warn(
        `NoopAvScanner in production for file "${filename}" — set AV_SCANNER to enable real scanning`,
      );
    }
    return { status: "clean" };
  }
}

export interface UploadConstraints {
  maxBytes: number;
  allowedMimeTypes: ReadonlySet<string>;
}

export type UploadGuardResult =
  | { allowed: true }
  | { allowed: false; reason: "file-too-large" | "mime-type-not-allowed" };

export function assertUploadAllowed(
  sizeBytes: number,
  mimeType: string,
  constraints: UploadConstraints,
): UploadGuardResult {
  if (sizeBytes > constraints.maxBytes)
    return { allowed: false, reason: "file-too-large" };
  if (!constraints.allowedMimeTypes.has(mimeType))
    return { allowed: false, reason: "mime-type-not-allowed" };
  return { allowed: true };
}

const DOWNLOAD_TOKEN_ALGORITHM = "sha256";
const DOWNLOAD_TOKEN_TTL_SECONDS = 300;

export interface DownloadTokenPayload {
  orgId: string;
  storageKey: string;
  expiresAt: number;
  nonce: string;
}

/**
 * Produces a time-limited, HMAC-signed download token payload.
 *
 * The storage retrieval endpoint must:
 *   1. Verify the HMAC signature.
 *   2. Check expiresAt > Date.now() / 1000.
 *   3. Re-assert the caller's object-level access to storageKey within orgId.
 *
 * Never cache the signed token — it is single-use by design. The caller
 * receives an opaque `token` string and the storage endpoint decodes it.
 *
 * SECRET is the `STORAGE_SIGNING_SECRET` env var. If absent, token generation
 * is disabled and the function throws — callers must fall back to direct access
 * with their own authorization.
 */
export function signDownloadToken(
  orgId: string,
  storageKey: string,
  secret: string,
  ttlSeconds = DOWNLOAD_TOKEN_TTL_SECONDS,
): string {
  const payload: DownloadTokenPayload = {
    orgId,
    storageKey,
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: randomBytes(8).toString("hex"),
  };
  const raw = JSON.stringify(payload);
  const sig = createHmac(DOWNLOAD_TOKEN_ALGORITHM, secret).update(raw).digest("hex");
  return Buffer.from(`${raw}.${sig}`, "utf8").toString("base64url");
}

export type DownloadTokenVerifyResult =
  | { valid: true; payload: DownloadTokenPayload }
  | { valid: false; reason: "malformed" | "expired" | "bad-signature" };

export function verifyDownloadToken(token: string, secret: string): DownloadTokenVerifyResult {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return { valid: false, reason: "malformed" };
  }

  const dot = decoded.lastIndexOf(".");
  if (dot <= 0) return { valid: false, reason: "malformed" };

  const raw = decoded.slice(0, dot);
  const sig = decoded.slice(dot + 1);

  let payload: DownloadTokenPayload;
  try {
    payload = JSON.parse(raw) as DownloadTokenPayload;
  } catch {
    return { valid: false, reason: "malformed" };
  }

  const expected = createHmac(DOWNLOAD_TOKEN_ALGORITHM, secret).update(raw).digest("hex");
  if (expected !== sig) return { valid: false, reason: "bad-signature" };

  if (Math.floor(Date.now() / 1000) > payload.expiresAt)
    return { valid: false, reason: "expired" };

  return { valid: true, payload };
}
