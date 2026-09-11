import { extname } from "path";

/**
 * Object keys as strings, before anything reaches a bucket.
 *
 * Four pure functions that open no connection and read no configuration beyond
 * the public base URL handed to them. They are here because their failure mode
 * is not the storage service's: everything else in that file fails by throwing
 * `ServiceUnavailableException` or a 404 from S3, while these fail by *returning
 * the wrong string*, which is silent.
 *
 * `isValidFileKey` is the security boundary of the pair. Every rule in it
 * rejects a key that would address something other than the object the caller is
 * entitled to — `..` traversal, a backslash, a leading slash, an embedded NUL,
 * a `scheme:` prefix that would turn a key into a URL, and `?`/`#` which would
 * smuggle query or fragment past a naive concatenation. The final allowlist
 * regex is the actual gate; the checks above it are there so a rejection is
 * explainable. `getFileKeyFromUrl` is the same job from the other direction: a
 * URL that is not under our own public base yields "" rather than a key.
 *
 * Pure, so every one of those rules is provable from a string with no bucket and
 * no network — which is how `src/degradation/object-storage.spec.ts` already
 * tests them.
 */

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function getFileKeyFromUrl(url: string, publicUrlBase: string | undefined): string {
  const value = url.trim();
  if (!/^https?:\/\//i.test(value)) return value;

  const base = publicUrlBase?.replace(/\/$/, "");
  if (!base || !value.startsWith(`${base}/`)) return "";

  try {
    return decodeURIComponent(
      value.slice(base.length + 1).split(/[?#]/, 1)[0] ?? "",
    );
  } catch {
    return "";
  }
}

export function getFileNameFromKey(key: string): string {
  const parts = key.split("/");
  const last = parts[parts.length - 1] ?? "download";
  const match = last.match(/^(?:\d+|[0-9a-f-]{36})-(.+)$/i);
  return match ? match[1] : last;
}

export function getMimeType(filePath: string): string {
  return (
    MIME_MAP[extname(filePath).toLowerCase()] || "application/octet-stream"
  );
}

export function isValidFileKey(key: string): boolean {
  if (!key || key.length > 1024) return false;
  if (key.includes("..") || key.includes("\\") || key.startsWith("/"))
    return false;
  if (key.includes("\0")) return false;
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(key) ||
    key.includes("?") ||
    key.includes("#")
  )
    return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key);
}
