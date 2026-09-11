import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";

export const CALENDAR_WEBHOOK_SECRET_HEADER = "x-calendar-webhook-secret";

/**
 * Providers cannot carry a session, so the relay authenticates with a shared secret.
 * Unset means the receiver is not deployed: it refuses every delivery rather than
 * accepting unauthenticated ones.
 */
export function assertCalendarWebhookSecret(provided: string | undefined): void {
  const expectedSecret = process.env.CALENDAR_PROVIDER_WEBHOOK_SECRET;
  if (!expectedSecret) {
    throw new ServiceUnavailableException("Calendar provider webhooks are not configured");
  }

  const token = provided?.trim() ?? "";
  if (!token) throw new UnauthorizedException("Unauthorized");

  const suppliedBytes = Buffer.from(token, "utf-8");
  const expectedBytes = Buffer.from(expectedSecret, "utf-8");
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new UnauthorizedException("Unauthorized");
  }
}
