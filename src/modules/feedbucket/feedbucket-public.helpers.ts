import { z } from "zod";
import type { Request } from "express";
import { feedbucketWidgets } from "../../db/schema";

export const publicKeyParams = z.object({ publicKey: z.string().min(1) }).strict();

export const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_RECORDING_BYTES = 100 * 1024 * 1024;

export function projectFolder(widget: typeof feedbucketWidgets.$inferSelect): string {
  return widget.projectId
    ? `project-${widget.projectId}`
    : `org-${widget.orgId}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
