import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * The messages the system decided to send on the tenant's behalf.
 *
 * A row exists from the moment a draft is written, not from the moment it
 * leaves, because everything interesting about this feature happens in between:
 * the hold window, the human who stopped it, the guardrail that refused it at
 * send time. A table that only recorded successful sends would answer none of
 * the questions anybody actually asks it.
 */

export const OUTBOUND_MESSAGE_STATUSES = [
  "drafted",
  "held",
  "sent",
  "cancelled",
  "blocked",
  "failed",
] as const;
export type OutboundMessageStatus = (typeof OUTBOUND_MESSAGE_STATUSES)[number];

export const crmOutboundMessages = pgTable(
  "crm_outbound_messages",
  {
    outboundMessageId: text("outbound_message_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * Who it is to, as a party rather than an address.
     *
     * The frequency cap is per party across every loop, and an address is not a
     * party — a customer with a work address and a personal one would otherwise
     * get one message on each and every cap would report itself as respected.
     */
    partyId: text("party_id").notNull(),
    /** The CRM contact, where the party maps to one; needed for consent and unsubscribe. */
    contactId: integer("contact_id"),
    dealId: text("deal_id"),

    /** `follow_up` · `nudge` · `check_in` · `meeting_request` · `cold_outreach`. */
    outboundClass: text("outbound_class").notNull(),
    /** `engaged` or `cold`. Derived from the class and stored so a query can filter it. */
    track: text("track").notNull(),
    channel: text("channel").default("EMAIL").notNull(),

    subject: text("subject").notNull(),
    body: text("body").notNull(),

    /**
     * The address it actually went to, recorded on the send rather than the draft.
     *
     * Null until it leaves. The address is re-resolved at send time — a contact
     * who changed their mail during the hold window must not receive it at the
     * old one — so writing it at draft time would record a claim the send did
     * not honour. It is stored at all because the bounce and complaint rates
     * that pause the cold track are computed by matching these against the
     * suppression list, and a hash cannot be matched against the addresses the
     * provider reports.
     */
    recipientEmail: text("recipient_email"),

    status: text("status").$type<OutboundMessageStatus>().default("drafted").notNull(),
    /** The guardrail that refused it, in the vocabulary of `send-guardrails.ts`. */
    blockedReason: text("blocked_reason"),
    /** How many times the clock put it off. Bounded — see `MAX_WORKING_HOUR_DEFERRALS`. */
    workingHourDeferrals: integer("working_hour_deferrals").default(0).notNull(),
    /** Which clock the working-hours check actually used, and whose it was. */
    timezoneUsed: text("timezone_used"),
    timezoneSource: text("timezone_source"),

    /** The ledger row. Every send is a decision record; this is the join to it. */
    autonomousDecisionId: text("autonomous_decision_id").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),

    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * The frequency cap's read: everything sent to one party, newest first.
     * Partial on `sent`, because that is the only status the cap counts and it
     * is a small slice of a table that only grows.
     */
    index("idx_crm_outbound_party_sent")
      .on(t.organizationId, t.partyId, t.sentAt)
      .where(sql`${t.status} = 'sent'`),
    index("idx_crm_outbound_org_created").on(t.organizationId, t.createdAt),
    index("idx_crm_outbound_decision").on(t.organizationId, t.autonomousDecisionId),
    /** The cold track's daily count and its bounce reconciliation. */
    index("idx_crm_outbound_track_sent")
      .on(t.organizationId, t.track, t.sentAt)
      .where(sql`${t.status} = 'sent'`),
  ],
);

/**
 * A class of message, stopped for one party, pending review.
 *
 * Ticket 08's fourth criterion, and the one that distinguishes a safeguard from
 * an undo button. Somebody who cancels a meeting request to a customer is
 * telling us something about that customer, not about that message — and a
 * system that re-drafts the identical thing an hour later has learned nothing
 * and looks like it is arguing.
 *
 * A row per stop rather than a flag on the party, so the history survives the
 * release and a reviewer can see it was stopped twice.
 */
export const crmOutboundClassStops = pgTable(
  "crm_outbound_class_stops",
  {
    outboundClassStopId: text("outbound_class_stop_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    partyId: text("party_id").notNull(),
    outboundClass: text("outbound_class").notNull(),

    /** The message whose cancellation caused this, so the reviewer can read it. */
    outboundMessageId: text("outbound_message_id"),
    reason: text("reason"),
    /** No FK to users — see migration 0223, for the same reason as the ledger. */
    stoppedByUserId: text("stopped_by_user_id"),
    stoppedAt: timestamp("stopped_at").defaultNow().notNull(),

    /** Null while the stop is live. Cleared only by a person. */
    releasedAt: timestamp("released_at"),
    releasedByUserId: text("released_by_user_id"),
  },
  (t) => [
    /**
     * One live stop per (party, class). A second would make "is this stopped"
     * depend on which row a query happened to read, and releasing one of two
     * would look like it had worked.
     */
    uniqueIndex("uniq_crm_outbound_class_stops_live")
      .on(t.organizationId, t.partyId, t.outboundClass)
      .where(sql`${t.releasedAt} IS NULL`),
    index("idx_crm_outbound_class_stops_party").on(t.organizationId, t.partyId, t.stoppedAt),
  ],
);

/**
 * Whether this tenant may run cold outbound at all.
 *
 * A row per tenant with `enabled` defaulting to false, and — deliberately — the
 * absence of a row meaning the same thing. A tenant that has never heard of
 * this feature and a tenant that turned it off must be indistinguishable to the
 * gate, because the gate is the only thing standing between an unconfigured
 * tenant and a cold campaign.
 */
export const crmColdOutboundSettings = pgTable("crm_cold_outbound_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),

  enabled: boolean("enabled").default(false).notNull(),
  enabledAt: timestamp("enabled_at"),
  /** No FK to users — an offboarding must not silently re-enable the track. */
  enabledByUserId: text("enabled_by_user_id"),

  /**
   * Set by the track itself when bounces or complaints cross their ceiling.
   *
   * Nobody decides this; the send path writes it and refuses. Cleared only by a
   * person, on purpose — a pause that expires on its own is a pause that
   * resumes sending into whatever caused it.
   */
  pausedAt: timestamp("paused_at"),
  pauseReason: text("pause_reason"),
  pausedByUserId: text("paused_by_user_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const SENDING_DOMAIN_PURPOSES = ["transactional", "cold"] as const;
export type SendingDomainPurpose = (typeof SENDING_DOMAIN_PURPOSES)[number];

/**
 * The domains a tenant sends from, and what each is for.
 *
 * `purpose` is the mechanism behind ticket 09's last criterion: the cold track
 * refuses any domain not registered as `cold`, and refuses one that shares a
 * registrable domain with the transactional sender. Separating them is the
 * whole point — a cold campaign that damages `acme-outreach.com` leaves
 * `acme.com`'s invoices and password resets arriving.
 */
export const crmSendingDomains = pgTable(
  "crm_sending_domains",
  {
    sendingDomainId: text("sending_domain_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    domain: text("domain").notNull(),
    purpose: text("purpose").$type<SendingDomainPurpose>().notNull(),

    /** DNS proved. Until then the domain sends nothing on the cold track. */
    verifiedAt: timestamp("verified_at"),
    /** The day the ramp starts counting from. Null means warm-up never began. */
    warmupStartedAt: timestamp("warmup_started_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("uniq_crm_sending_domains_org_domain").on(t.organizationId, t.domain),
    /**
     * One cold domain per tenant. Two would let a tenant run each up to its own
     * ramp and send double the volume the schedule permits, which is the ramp
     * not existing.
     */
    uniqueIndex("uniq_crm_sending_domains_cold")
      .on(t.organizationId)
      .where(sql`${t.purpose} = 'cold'`),
  ],
);
