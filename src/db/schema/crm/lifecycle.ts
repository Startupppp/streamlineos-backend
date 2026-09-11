import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  timestamp,
  date,
  integer,
  bigint,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * What a won deal turns into once the money starts recurring.
 *
 * A pipeline answers "will we win this". Nothing in the CRM answers "will we
 * keep it" — a deal that reaches a won stage stops moving, its row goes quiet,
 * and the next thing anybody hears about that customer is a cancellation. The
 * revenue was at risk for months and the system had no place to say so, because
 * it had no record that the revenue was recurring at all.
 *
 * That record is this. It carries the three facts a renewal conversation needs
 * before it is urgent — when the term ends, how long it runs, what it is worth —
 * and the evidence that accumulated in between.
 *
 * Anchored to the Party, never to a legacy identifier. `business_parties` is the
 * canonical identity and the legacy identity tables were dropped; the composite
 * foreign key on (organization_id, party_id) is what makes "this revenue belongs
 * to that customer" a fact the database holds rather than a join we hope about.
 */

/*
 * Customer health (the assessments and their factors) and the renewal and churn
 * triggers live beside this file, re-exported here so every importer of
 * `crm/lifecycle` keeps its path.
 */
export * from "./lifecycle-health";
export * from "./lifecycle-triggers";

/**
 * Where a lifecycle is in its term.
 *
 * There is no `renewed` here, deliberately. A renewal ADVANCES this row — the
 * new term starts where the old one ended and `renewal_count` goes up — rather
 * than closing it and opening a successor. The book's whole question is "when
 * does this contract next come up", and a chain of closed rows makes that
 * question require a walk backwards through the history to answer. The renewal
 * itself is not lost: it is filed as a `renewal-commitment` signal, which is
 * where the evidence about a relationship belongs anyway.
 *
 * `churned` and `cancelled` are both endings and deliberately distinct: one
 * reached its renewal date and was not renewed, the other was ended inside the
 * term. Collapsing them would make the renewal rate unmeasurable — every
 * mid-term cancellation would count against a renewal that was never offered.
 */
export const CUSTOMER_LIFECYCLE_STATUSES = ["active", "churned", "cancelled"] as const;
export type CustomerLifecycleStatus = (typeof CUSTOMER_LIFECYCLE_STATUSES)[number];

/**
 * The kinds of evidence that a recurring relationship is going well or badly.
 *
 * Both directions are in one vocabulary on purpose. A signal history that can
 * only record harm produces a risk score that only ever rises, and a number that
 * cannot fall is a number nobody trusts after the first quarter — the customer
 * who escalated in March and has since signed an expansion would still be
 * flagged in September.
 */
export const LIFECYCLE_SIGNAL_KINDS = [
  /** A support case escalated above its owner. */
  "support-escalation",
  /** An invoice went past due. */
  "invoice-overdue",
  /** The person who bought it left, or left the account. */
  "champion-departed",
  /** Measured usage fell against this customer's own baseline. */
  "usage-decline",
  /** A survey answer in the detractor band. */
  "detractor-response",
  /** Nobody on either side has spoken for longer than this relationship's normal. */
  "relationship-silence",
  /** They asked about more of it. */
  "expansion-interest",
  /** Somebody with authority said they are renewing. */
  "renewal-commitment",
  /** A human wrote something down. Carries whatever impact they stated. */
  "note",
] as const;
export type LifecycleSignalKind = (typeof LIFECYCLE_SIGNAL_KINDS)[number];

/** Whether the system observed a signal or a person filed it. */
export const LIFECYCLE_SIGNAL_SOURCES = ["system", "human"] as const;
export type LifecycleSignalSource = (typeof LIFECYCLE_SIGNAL_SOURCES)[number];

export const customerLifecycles = pgTable(
  "customer_lifecycles",
  {
    customerLifecycleId: text("customer_lifecycle_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The customer, as a Party.
     *
     * Not nullable, and that is the whole reason a lifecycle is not written for
     * every won deal: a deal that names nobody resolvable has no customer whose
     * revenue this could be, and inventing a row for it would put untraceable
     * money into the renewal forecast.
     */
    partyId: text("party_id").notNull(),

    /**
     * The deal that produced this, and the idempotency key of the whole feature.
     *
     * `uniq_customer_lifecycles_deal` makes a second closed-won transition on
     * the same deal a no-op rather than a duplicate term. Deals move backwards
     * and forwards through stages routinely — an approval is reversed, a rep
     * corrects a misclick — and without this, one customer would appear in the
     * renewal book twice for the same contract.
     *
     * Integer, matching `deals.id`, and carrying a composite tenant foreign key
     * so a lifecycle cannot cite another organisation's deal.
     */
    sourceDealId: integer("source_deal_id").notNull(),

    status: text("status")
      .$type<CustomerLifecycleStatus>()
      .default("active")
      .notNull(),

    /** The day the term began: the deal's close date. */
    startedOn: date("started_on").notNull(),
    /** How long the term runs. Bounded 1..120 by a CHECK. */
    termMonths: integer("term_months").notNull(),
    /**
     * `started_on` plus the term, stored rather than derived.
     *
     * A generated column would be the tidier answer and cannot be one: the
     * addition has to clamp the day of month (31 January plus one month is 28
     * February, not 3 March) and a renewal that is later re-termed keeps its
     * agreed date. Stored, so the renewal book is what was agreed rather than
     * what arithmetic re-derives.
     */
    renewalOn: date("renewal_on").notNull(),

    /**
     * The recurring value, in the organisation's currency's minor units.
     *
     * Integer minor units, like `deals.value_minor` it is copied from. There is
     * deliberately no `currency` column: the amount is already denominated in
     * `organizations.currency`, and a second copy of that fact is a second thing
     * that can disagree with the deal this was made from.
     */
    contractValueMinor: bigint("contract_value_minor", { mode: "number" })
      .default(0)
      .notNull(),

    /**
     * How many times this contract has been renewed in place.
     *
     * The only trace a renewal leaves in the row itself, and it is here because
     * it is the one fact the row cannot re-derive: `started_on` moves forward on
     * each renewal, so a second-year customer and a first-year one are otherwise
     * indistinguishable — and tenure is the strongest thing anybody knows about
     * whether a renewal will happen again.
     */
    renewalCount: integer("renewal_count").default(0).notNull(),

    /**
     * 0..100, recomputed from the signal history whenever it changes.
     *
     * Materialised rather than computed on read because the list this exists to
     * produce — every customer whose renewal is coming and whose signals are bad
     * — sorts on it, and a sort on a value no index can hold degrades into
     * reading the whole book.
     */
    riskScore: integer("risk_score").default(0).notNull(),
    riskComputedAt: timestamp("risk_computed_at"),
    /** Newest signal, so a stale score is visible as one. */
    lastSignalAt: timestamp("last_signal_at"),

    /** Set together when the lifecycle ends. Why, in the tenant's words. */
    closedReason: text("closed_reason"),
    closedAt: timestamp("closed_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * One lifecycle per deal. See `sourceDealId` — this index is what makes the
     * closed-won hook safe to run again.
     *
     * Not per party: a customer who buys a second product has two contracts with
     * two terms and two renewal dates, and folding them into one row would hide
     * whichever renews first.
     */
    uniqueIndex("uniq_customer_lifecycles_deal").on(t.organizationId, t.sourceDealId),

    /**
     * The renewal book: what is coming, soonest first. Partial on `active`,
     * because a renewed or churned term has no renewal to prepare for and the
     * closed rows are the half of this table that only grows.
     */
    index("idx_customer_lifecycles_renewal").on(
      t.organizationId,
      t.status,
      t.renewalOn,
    ),
    /** The at-risk read, which sorts on the score rather than the date. */
    index("idx_customer_lifecycles_risk").on(t.organizationId, t.status, t.riskScore),
    /** Every contract this customer holds — the account view's question. */
    index("idx_customer_lifecycles_party").on(t.organizationId, t.partyId),

    /** The composite tenant key the signal table points at. */
    unique("uniq_customer_lifecycles_org_id").on(t.organizationId, t.customerLifecycleId),
  ],
);

export const customerLifecycleSignals = pgTable(
  "customer_lifecycle_signals",
  {
    lifecycleSignalId: text("lifecycle_signal_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    customerLifecycleId: text("customer_lifecycle_id").notNull(),

    kind: text("kind").$type<LifecycleSignalKind>().notNull(),

    /**
     * Signed, -100..100, and signed is the point.
     *
     * A positive number is pressure toward churn and a negative one is evidence
     * against it. Storing magnitude plus a polarity looked up from the kind
     * would mean re-scoring the whole history every time somebody re-classified
     * a kind, which is how a risk number changes for a customer nothing happened
     * to. What was concluded at the time stays concluded.
     */
    impact: integer("impact").notNull(),

    /**
     * When the thing happened, not when it was filed.
     *
     * The decay in `lifecycle-risk.ts` reads this, so a backfilled escalation
     * from March weighs what March weighs. Defaulting it to the insert time
     * would make every import look like a crisis this morning.
     */
    observedAt: timestamp("observed_at").defaultNow().notNull(),

    source: text("source").$type<LifecycleSignalSource>().default("system").notNull(),
    /**
     * Who filed it, when a person did.
     *
     * No foreign key to `users`, following 0223: `scripts/purge-user.mjs`
     * deletes every row referencing `users` whatever the delete rule says, and
     * offboarding one account manager must not erase the evidence behind a
     * customer's risk score.
     */
    recordedByUserId: text("recorded_by_user_id"),

    note: text("note"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /**
     * The history read, newest first, and the composite foreign key's own
     * delete-time lookup — one index serves both.
     */
    index("idx_customer_lifecycle_signals_lifecycle").on(
      t.organizationId,
      t.customerLifecycleId,
      t.observedAt,
    ),
  ],
);

export type CustomerLifecycleRow = typeof customerLifecycles.$inferSelect;
export type CustomerLifecycleSignalRow = typeof customerLifecycleSignals.$inferSelect;
