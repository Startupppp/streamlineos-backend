import { Injectable, Logger } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";
import { EmailSuppressionService, type EmailSuppressionReason } from "./email-suppression.service";

export type EmailWebhookProvider = "resend" | "zeptomail";

export interface EmailWebhookResult {
  status: number;
  body: { ok: boolean; suppressed?: number; message?: string };
}

/** Provider event names that must suppress the address, and what to record. */
const SUPPRESSING_EVENTS: Record<string, EmailSuppressionReason> = {
  // Resend
  "email.bounced": "HARD_BOUNCE",
  "email.complained": "COMPLAINT",
  // ZeptoMail
  hardbounce: "HARD_BOUNCE",
  bounce: "HARD_BOUNCE",
  spam: "COMPLAINT",
  complaint: "COMPLAINT",
  invalid: "INVALID_ADDRESS",
};

/**
 * How long a spam complaint suppresses the address for.
 *
 * A hard bounce and an invalid address are facts about the ADDRESS — it does not
 * exist, nobody can deliver to it — so they stay permanent and platform-wide. A
 * complaint is a fact about ONE relationship: alice@corp.com marked one tenant's
 * broadcast as spam. It was being written with the same `orgId: null` and no
 * expiry, and `email_suppressions` has no reversal path anywhere in the product
 * (`emailSuppressions` is referenced by exactly two non-spec files, exposing only
 * `findSuppressed` and `suppress`, and `suppress` is `onConflictDoNothing` so a
 * later write cannot correct it). So one click in one tenant permanently stopped
 * every other tenant's password resets, invoices and e-signature requests to her,
 * with a DBA as the only way back.
 *
 * The scope stays platform-wide because neither provider's payload names a tenant:
 * `email_outbox` has no provider message id to join on, and nothing tags outbound
 * mail with the organisation. Guessing the tenant from the most recent send to that
 * address would silently suppress the WRONG tenant whenever it guessed wrong, which
 * is worse than what it replaces. Bounding it in time is the part that can be done
 * correctly here: `findSuppressed` already ignores an expired row
 * (`or(isNull(expiresAt), gt(expiresAt, now))`), so this needs no new read path and
 * no schema change, and the suppression heals itself instead of needing a human who
 * has no button to press.
 */
const COMPLAINT_SUPPRESSION_DAYS = 365;

function constantTimeEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * SEC-002. Receives provider bounce and complaint callbacks and writes the
 * suppression list.
 *
 * Every path fails closed. An unauthenticated bounce webhook lets anyone suppress
 * any address — a denial-of-service against a specific user's mail — so a missing
 * secret rejects rather than accepts.
 */
@Injectable()
export class EmailWebhookService {
  private readonly logger = new Logger(EmailWebhookService.name);

  constructor(private readonly suppression: EmailSuppressionService) {}

  async handle(params: {
    provider: EmailWebhookProvider;
    rawBody: string;
    headers: Record<string, string | undefined>;
  }): Promise<EmailWebhookResult> {
    if (!this.verify(params.provider, params.rawBody, params.headers))
      return { status: 401, body: { ok: false, message: "Invalid signature" } };

    let payload: unknown;
    try {
      payload = JSON.parse(params.rawBody);
    } catch {
      return { status: 400, body: { ok: false, message: "Malformed body" } };
    }

    const events = this.extractEvents(payload);
    let suppressed = 0;
    for (const event of events) {
      const reason = SUPPRESSING_EVENTS[event.type.toLowerCase()];
      if (!reason || !event.email) continue;
      await this.suppression.suppress({
        email: event.email,
        // Platform-wide: a hard bounce is a property of the address, not a tenant.
        orgId: null,
        reason,
        source: "PROVIDER_WEBHOOK",
        // A complaint is a relationship, not an address defect — it expires.
        // A bounce and an invalid address do not.
        expiresAt:
          reason === "COMPLAINT"
            ? new Date(Date.now() + COMPLAINT_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000)
            : null,
        evidence: { provider: params.provider, type: event.type },
      });
      suppressed++;
    }

    return { status: 200, body: { ok: true, suppressed } };
  }

  private verify(
    provider: EmailWebhookProvider,
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): boolean {
    if (provider === "resend") return this.verifySvix(rawBody, headers);

    // ZeptoMail's documented signing scheme has not been confirmed against a live
    // account, so rather than guess at an HMAC construction that would silently
    // accept everything if wrong, this requires a shared secret compared in
    // constant time. Replace with the provider's real scheme once verified.
    const secret = process.env.ZEPTOMAIL_WEBHOOK_SECRET;
    const provided = headers["x-zeptomail-webhook-secret"] ?? headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!secret || !provided) return false;
    return constantTimeEquals(secret, provided);
  }

  /**
   * Resend signs with Svix: HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed on
   * the base64 secret after the `whsec_` prefix. The signature header may carry
   * several space-separated `v1,<sig>` values during key rotation; any match passes.
   */
  private verifySvix(rawBody: string, headers: Record<string, string | undefined>): boolean {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    const id = headers["svix-id"];
    const timestamp = headers["svix-timestamp"];
    const signatureHeader = headers["svix-signature"];
    if (!secret || !id || !timestamp || !signatureHeader) return false;

    // Reject replays outside a five-minute window.
    const sentAt = Number(timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() / 1000 - sentAt) > 300) return false;

    try {
      const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
      const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
      return signatureHeader
        .split(" ")
        .map((part) => part.split(",")[1] ?? "")
        .some((candidate) => candidate.length > 0 && constantTimeEquals(expected, candidate));
    } catch {
      return false;
    }
  }

  /** Both providers send either a single event object or a list. */
  private extractEvents(payload: unknown): Array<{ type: string; email: string | null }> {
    const items = Array.isArray(payload) ? payload : [payload];
    const events: Array<{ type: string; email: string | null }> = [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const record: Record<string, unknown> = { ...item };
      const type = record.type ?? record.event_name ?? record.event;
      if (typeof type !== "string") continue;
      events.push({ type, email: this.extractEmail(record) });
    }
    return events;
  }

  private extractEmail(record: Record<string, unknown>): string | null {
    const data = typeof record.data === "object" && record.data !== null ? record.data : record;
    const bag: Record<string, unknown> = { ...data };
    const direct = bag.email ?? bag.email_address ?? bag.recipient;
    if (typeof direct === "string") return direct;
    // Resend puts recipients in `data.to`, which may be a list.
    const to = bag.to;
    if (typeof to === "string") return to;
    if (Array.isArray(to) && typeof to[0] === "string") return to[0];
    return null;
  }
}
