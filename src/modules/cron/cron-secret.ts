import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";

export function assertCronSecret(authHeader: string | undefined): void {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    throw new ServiceUnavailableException("CRON_SECRET not configured");
  }

  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (!token) {
    throw new UnauthorizedException("Unauthorized");
  }

  const provided = Buffer.from(token, "utf-8");
  const expected = Buffer.from(cronSecret, "utf-8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new UnauthorizedException("Unauthorized");
  }
}
