import { readFileSync, existsSync, statSync } from "node:fs";

export const EXPECTED_FIELDS = {
  requestCount: "number — total HTTP requests completed during the load run",
  durationMs: "number — wall-clock duration of the load run in milliseconds",
  realtimeConnectionMinutes: "number (optional) — sum of connection-minutes across all Ably connections opened during the run",
};

export function readLoadDriverResults(filePath) {
  if (!existsSync(filePath)) return null;

  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return { status: "parse-error", path: filePath };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { status: "parse-error", path: filePath, reason: "root must be a JSON object" };

  const obj = raw;
  const requestCount = typeof obj.requestCount === "number" && Number.isFinite(obj.requestCount)
    ? obj.requestCount
    : null;
  const durationMs = typeof obj.durationMs === "number" && Number.isFinite(obj.durationMs) && obj.durationMs > 0
    ? obj.durationMs
    : null;
  const realtimeConnectionMinutes = typeof obj.realtimeConnectionMinutes === "number" && Number.isFinite(obj.realtimeConnectionMinutes)
    ? obj.realtimeConnectionMinutes
    : null;

  const modifiedAt = statSync(filePath).mtimeMs;

  return {
    status: "ok",
    requestCount,
    durationMs,
    realtimeConnectionMinutes,
    modifiedAt,
    missingFields: [
      requestCount === null && "requestCount",
      durationMs === null && "durationMs",
    ].filter(Boolean),
  };
}

export function isDuringBulkLoad(modifiedAt, windowMs) {
  if (modifiedAt == null) return false;
  return Date.now() - modifiedAt < (windowMs ?? 3_600_000);
}
