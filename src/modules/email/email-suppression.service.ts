import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, or, gt } from "drizzle-orm";
import { emailSuppressions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

export type EmailSuppressionReason =
  (typeof emailSuppressions.reason.enumValues)[number];
export type EmailSuppressionSource =
  (typeof emailSuppressions.source.enumValues)[number];

export function canonicalEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * SEC-002/SEC-003. The suppression list, enforced at the single choke point every
 * email in the product passes through — `EmailService` overrides the base sender to
 * route through `EmailOutboxService.enqueueAndTry`, so all 75 direct-send call sites
 * are covered without touching one of them.
 *
 * Suppression is absolute. It applies to mandatory notification types too: a
 * hard-bounced address is not deliverable regardless of policy, and continuing to
 * send to it damages delivery for every other recipient on the domain.
 */
@Injectable()
export class EmailSuppressionService {
  private readonly logger = new Logger(EmailSuppressionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Returns the subset of `emails` that must NOT be sent to. Matches a
   * platform-wide row (`org_id IS NULL`) or a row for this tenant, ignoring
   * anything already expired.
   */
  async findSuppressed(emails: string[], orgId: string | null): Promise<Set<string>> {
    const canonical = [...new Set(emails.map(canonicalEmail))].filter(Boolean);
    if (canonical.length === 0) return new Set();

    const now = new Date();
    const rows = await this.db
      .select({ email: emailSuppressions.email })
      .from(emailSuppressions)
      .where(
        and(
          inArray(emailSuppressions.email, canonical),
          eq(emailSuppressions.channel, "EMAIL"),
          or(isNull(emailSuppressions.expiresAt), gt(emailSuppressions.expiresAt, now)),
          orgId
            ? or(isNull(emailSuppressions.orgId), eq(emailSuppressions.orgId, orgId))
            : isNull(emailSuppressions.orgId),
        ),
      );

    return new Set(rows.map((r) => r.email));
  }

  /**
   * Idempotent. A provider that redelivers the same bounce must not create a second
   * row, so the upsert targets the partial unique that matches this row's scope.
   */
  async suppress(input: {
    email: string;
    orgId?: string | null;
    reason: EmailSuppressionReason;
    source: EmailSuppressionSource;
    evidence?: Record<string, unknown>;
  }): Promise<void> {
    const email = canonicalEmail(input.email);
    if (!email) return;
    const orgId = input.orgId ?? null;

    await this.db
      .insert(emailSuppressions)
      .values({
        email,
        orgId,
        channel: "EMAIL",
        reason: input.reason,
        source: input.source,
        evidence: input.evidence ?? null,
      })
      // `where` is the index predicate on the conflict target, so this resolves to
      // the matching partial unique — the global one or the per-org one.
      .onConflictDoNothing(
        orgId
          ? {
              target: [emailSuppressions.orgId, emailSuppressions.email, emailSuppressions.channel],
              where: isNotNull(emailSuppressions.orgId),
            }
          : {
              target: [emailSuppressions.email, emailSuppressions.channel],
              where: isNull(emailSuppressions.orgId),
            },
      );

    this.logger.log(
      `EMAIL_SUPPRESSED reason=${input.reason} source=${input.source} scope=${orgId ?? "platform"}`,
    );
  }
}
