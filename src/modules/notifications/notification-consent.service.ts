import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  notificationConsentEvents,
  notificationConsents,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CONSENT_REQUIRED_CHANNELS } from "./notification-routing-computation";
import type { NotificationChannel } from "./notification.types";

export type ConsentChannel = (typeof CONSENT_REQUIRED_CHANNELS)[number];
export type ConsentState = "GRANTED" | "WITHDRAWN";
export type ConsentSource = "USER" | "ADMIN" | "IMPORT" | "SIGNUP" | "API";
export type ConsentLegalBasis =
  | "CONSENT"
  | "CONTRACT"
  | "LEGITIMATE_INTEREST"
  | "LEGAL_OBLIGATION";

export interface RecordConsentInput {
  channel: ConsentChannel;
  destination: string;
  state: ConsentState;
  source?: ConsentSource;
  legalBasis?: ConsentLegalBasis;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ConsentRow {
  channel: NotificationChannel;
  destination: string;
  state: ConsentState;
  source: ConsentSource;
  legalBasis: ConsentLegalBasis;
  grantedAt: Date | null;
  withdrawnAt: Date | null;
  updatedAt: Date;
}

/**
 * COMP-003. The writer half. `notification_consents` and its append-only companion
 * `notification_consent_events` shipped as schema with no reader and no writer:
 * `computeRouting` never consulted them, so SMS and WhatsApp routed on a preference
 * toggle, and the GDPR export adapter — the one thing that did read the table —
 * returned an empty list for every subject.
 *
 * Two rows per decision, deliberately. The current-state table is what routing
 * reads and is mutable (a withdrawal flips `state` in place, so the unique index on
 * (org, membership, channel, destination) keeps exactly one live answer). The event
 * table is the immutable record §20 requires, which a table carrying a mutable
 * `state` cannot be on its own.
 */
@Injectable()
export class NotificationConsentService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(
    orgId: string,
    membershipId: number | null | undefined,
  ): Promise<ConsentRow[]> {
    if (membershipId == null) return [];
    const rows = await this.db
      .select({
        channel: notificationConsents.channel,
        destination: notificationConsents.destination,
        state: notificationConsents.state,
        source: notificationConsents.source,
        legalBasis: notificationConsents.legalBasis,
        grantedAt: notificationConsents.grantedAt,
        withdrawnAt: notificationConsents.withdrawnAt,
        updatedAt: notificationConsents.updatedAt,
      })
      .from(notificationConsents)
      .where(
        and(
          eq(notificationConsents.orgId, orgId),
          eq(notificationConsents.membershipId, membershipId),
        ),
      )
      .limit(CONSENT_REQUIRED_CHANNELS.length * 20);
    return rows;
  }

  async record(
    orgId: string,
    userId: string,
    membershipId: number | null | undefined,
    input: RecordConsentInput,
  ): Promise<ConsentRow> {
    if (membershipId == null)
      throw new ForbiddenException("Organization membership required");

    const now = new Date();
    const granted = input.state === "GRANTED";
    const source = input.source ?? "USER";
    const legalBasis = input.legalBasis ?? "CONSENT";

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(notificationConsents)
        .values({
          orgId,
          membershipId,
          channel: input.channel,
          destination: input.destination,
          state: input.state,
          source,
          legalBasis,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          grantedAt: granted ? now : null,
          withdrawnAt: granted ? null : now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            notificationConsents.orgId,
            notificationConsents.membershipId,
            notificationConsents.channel,
            notificationConsents.destination,
          ],
          set: {
            state: input.state,
            source,
            legalBasis,
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
            grantedAt: granted ? now : null,
            withdrawnAt: granted ? null : now,
            updatedAt: now,
          },
        })
        .returning({
          channel: notificationConsents.channel,
          destination: notificationConsents.destination,
          state: notificationConsents.state,
          source: notificationConsents.source,
          legalBasis: notificationConsents.legalBasis,
          grantedAt: notificationConsents.grantedAt,
          withdrawnAt: notificationConsents.withdrawnAt,
          updatedAt: notificationConsents.updatedAt,
        });

      await tx.insert(notificationConsentEvents).values({
        orgId,
        userId,
        channel: input.channel,
        destination: input.destination,
        state: input.state,
        source,
        legalBasis,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        occurredAt: now,
      });

      if (row === undefined)
        throw new ForbiddenException("Consent could not be recorded");
      return row;
    });
  }

  /**
   * Turning SMS or WhatsApp off in the preference centre is a withdrawal, not a
   * mute. A toggle that left a GRANTED row standing would mean the record of
   * agreement and the user's own stated wish disagreed, and the record is what an
   * auditor reads.
   */
  async withdrawChannel(
    orgId: string,
    userId: string,
    membershipId: number | null | undefined,
    channel: ConsentChannel,
  ): Promise<number> {
    if (membershipId == null) return 0;
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const withdrawn = await tx
        .update(notificationConsents)
        .set({ state: "WITHDRAWN", withdrawnAt: now, grantedAt: null, updatedAt: now })
        .where(
          and(
            eq(notificationConsents.orgId, orgId),
            eq(notificationConsents.membershipId, membershipId),
            eq(notificationConsents.channel, channel),
            eq(notificationConsents.state, "GRANTED"),
          ),
        )
        .returning({ destination: notificationConsents.destination });

      if (withdrawn.length === 0) return 0;
      await tx.insert(notificationConsentEvents).values(
        withdrawn.map((r) => ({
          orgId,
          userId,
          channel,
          destination: r.destination,
          state: "WITHDRAWN" as const,
          source: "USER" as const,
          legalBasis: "CONSENT" as const,
          occurredAt: now,
        })),
      );
      return withdrawn.length;
    });
  }

  async withdrawChannels(
    orgId: string,
    userId: string,
    membershipId: number | null | undefined,
    channels: readonly ConsentChannel[],
  ): Promise<number> {
    let total = 0;
    for (const channel of channels)
      total += await this.withdrawChannel(orgId, userId, membershipId, channel);
    return total;
  }

  async hasGrant(
    orgId: string,
    membershipId: number,
    channel: ConsentChannel,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: notificationConsents.id })
      .from(notificationConsents)
      .where(
        and(
          eq(notificationConsents.orgId, orgId),
          eq(notificationConsents.membershipId, membershipId),
          inArray(notificationConsents.channel, [channel]),
          eq(notificationConsents.state, "GRANTED"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
