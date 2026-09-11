/**
 * Request-shape helpers and upload guards shared by every route on the public
 * (unauthenticated) Feedbucket surface.
 *
 * All three public routes — `config`, `submit` and `ai-assist` — re-derive the
 * caller's IP and origin from raw headers, and two of them run the *identical*
 * screenshot admission check (size, declared MIME, magic bytes). That shared
 * admission rule is the seam: it is one rule about what the public may upload,
 * and it belongs in one place rather than transcribed per route.
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import { validateMagicBytes } from "../../storage/file-signatures";
import type { feedbucketWidgets } from "../../../db/schema";

export const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_RECORDING_BYTES = 100 * 1024 * 1024;

export type FeedbucketWidget = typeof feedbucketWidgets.$inferSelect;

export function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = raw?.split(",")[0]?.trim() || req.ip;
  return candidate ? candidate.slice(0, 100) : undefined;
}

export function originHostname(req: Request): string | undefined {
  const originHeader = req.headers["origin"];
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  const refererHeader = req.headers["referer"];
  const referer = Array.isArray(refererHeader)
    ? refererHeader[0]
    : refererHeader;
  const src = origin ?? referer;
  if (!src) return undefined;
  try {
    return new URL(src).hostname;
  } catch {
    return undefined;
  }
}

export function parseMultipartField(raw: unknown, fieldName: string): unknown {
  if (
    fieldName === "consoleLogs" ||
    fieldName === "metadata" ||
    fieldName === "networkLogs"
  ) {
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
  }
  return raw;
}

export function normalizeMultipartBody(
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(rawBody)) {
    normalized[key] = parseMultipartField(val, key);
  }
  return normalized;
}

/**
 * The widget's allowed-domain allowlist. A request with no resolvable origin is
 * allowed through unchanged (non-browser callers send neither Origin nor
 * Referer); only a *present and unlisted* host is refused.
 */
export function assertOriginAllowed(
  widget: FeedbucketWidget,
  req: Request,
): void {
  const host = originHostname(req);
  if (
    widget.allowedDomains.length > 0 &&
    host !== undefined &&
    !widget.allowedDomains.includes(host)
  ) {
    throw new ForbiddenException("Origin not allowed");
  }
}

/**
 * Screenshot admission: size cap, declared MIME allowlist, and magic-byte
 * agreement with that declared type. Runs on both `submit` and `ai-assist`.
 */
export function assertScreenshotAcceptable(
  screenshot: Express.Multer.File,
): void {
  if (screenshot.size > MAX_SCREENSHOT_BYTES)
    throw new BadRequestException("Screenshot must be under 5MB");

  if (!ALLOWED_IMAGE_MIMES.has(screenshot.mimetype))
    throw new BadRequestException(
      "Screenshot must be an image (JPEG, PNG, GIF, or WebP)",
    );

  if (!validateMagicBytes(screenshot.buffer, screenshot.mimetype))
    throw new BadRequestException(
      "Screenshot file content does not match its type",
    );
}
