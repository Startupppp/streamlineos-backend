import type { Request } from "express";

const MAX_STORED_IP_LENGTH = 100;

export function resolveClientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = raw?.split(",")[0]?.trim() || req.ip;
  return candidate ? candidate.slice(0, MAX_STORED_IP_LENGTH) : undefined;
}

export function resolveClientIpOr(req: Request, fallback: string): string {
  return resolveClientIp(req) ?? fallback;
}
