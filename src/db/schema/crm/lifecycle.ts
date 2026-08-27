import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  timestamp,
  date,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { crmHealthEnum } from "../common/enums";

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

/* ────────────────────────────────────────────────────────────────────────────
 * Customer health: a composite score that can be taken apart.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The four inputs a customer health score is made of.
 *
 * Fixed, and small. A health model whose input set is tenant-configurable
 * produces numbers that cannot be compared between two customers of the same
 * organisation once somebody edits the configuration, and there is already one
 * of those here: `health_score_config.weights` is a jsonb blob of five weights
 * with no version, so every historical row in `client_health_scores` silently
 * restates itself the moment it is edited.
 *
 * Each key names the QUESTION, never the table it happens to be answered from.
 * `support` is "how has service for this customer gone", and the fact that it is
 * currently read from `support_tickets` is a detail of `health.service.ts`, not
 * of the vocabulary a stored score is decomposed into.
 */
export const HEALTH_FACTOR_KEYS = [
  /** Are they using what they bought. */
  "usage",
  /** Is anybody on either side still talking. */
  "engagement",
  /** How has service for this customer gone. */
  "support",
  /** What did they sound like when they talked to us. */
  "sentiment",
] as const;
export type HealthFactorKey = (typeof HEALTH_FACTOR_KEYS)[number];

/** Whether an input was measured, or is being reported as absent. */
export const HEALTH_FACTOR_STATUSES = ["measured", "missing"] as const;
export type HealthFactorStatus = (typeof HEALTH_FACTOR_STATUSES)[number];

/**
 * Why an input is missing — three different facts, kept apart.
 *
 * `cs-health.service.ts` scores all three of these as `NEUTRAL_BASELINE = 50`,
 * which is the failure this vocabulary exists to prevent: a customer nobody has
 * ever surveyed and a customer whose survey came back neutral get the same
 * number, so the score cannot be argued with and the gap in the data never gets
 * fixed because nothing ever reports one.
 */
export const HEALTH_MISSING_REASONS = [
  /**
   * The organisation holds no source for this input at all — nobody records
   * activities, no ticket is anchored to a party, no usage observation has ever
   * been filed. Not a fact about this customer.
   */
  "no-source",
  /** The source is in use, but nothing has ever been observed for this customer. */
  "no-observations",
  /** Something was observed for this customer, all of it older than the window. */
  "stale",
] as const;
export type HealthMissingReason = (typeof HEALTH_MISSING_REASONS)[number];

/**
 * The current health of one customer, and the only place the composite lives.
 *
 * One row per party, replaced in place. Deliberately NOT an append-only history:
 * the inputs are read over moving windows against tables that are themselves
 * edited, so a row from March cannot be re-derived and a history of them would
 * be a pile of numbers nobody can check — which is what `client_health_scores`
 * already is. What makes a score here answerable is the factor rows beside it,
 * not a row from last quarter.
 *
 * `score` is NULLABLE and that is the whole point of the table. Null means the
 * model did not have enough of its inputs to answer, which is a different fact
 * from zero and from fifty, and it is carried all the way out to
 * `business_parties.health_score` rather than being rounded into a number
 * somebody would act on.
 */
export const customerHealthAssessments = pgTable(
  "customer_health_assessments",
  {
    customerHealthAssessmentId: text("customer_health_assessment_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The customer, as a Party — the same anchor `customer_lifecycles` uses.
     *
     * Not `client_account_id`, which is what `client_health_scores` is keyed on:
     * that is a legacy identity, and a health score anchored to it is invisible
     * to every party-native surface and doubles up for any customer whose two
     * legacy records were merged into one Party.
     */
    partyId: text("party_id").notNull(),

    /**
     * 0..100, or NULL for "not enough inputs to say".
     *
     * Null and zero are different claims and this column is allowed to make
     * both. See `MIN_HEALTH_COVERAGE_BPS` in `health-score.ts` for where the
     * line is drawn and why.
     */
    score: integer("score"),

    /**
     * The band, in `crm_health`'s own vocabulary rather than a fourth spelling
     * of it. `business_parties.health_status` is this enum, and the write-back
     * would otherwise need a translation table that could disagree with itself.
     * Null exactly when `score` is null, enforced by a CHECK.
     */
    healthStatus: crmHealthEnum("health_status"),

    /**
     * How much of the model's declared weight actually spoke, in basis points.
     *
     * Stored beside the score because it is the number that says how much the
     * score is worth: 68 out of a model that had two of its four inputs is not
     * the same claim as 68 out of a model that had all four, and a surface that
     * cannot tell them apart will present them identically.
     */
    coverageBps: integer("coverage_bps").notNull(),

    /**
     * Which weight table produced this. Bumped whenever the weights change.
     *
     * Without it, re-tuning the model silently restates every stored score —
     * the same defect as `health_score_config`, which has no version at all.
     */
    weightsVersion: integer("weights_version").notNull(),

    computedAt: timestamp("computed_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /** One current assessment per customer. The upsert's conflict target. */
    uniqueIndex("uniq_customer_health_assessments_party").on(
      t.organizationId,
      t.partyId,
    ),
    /**
     * The roster read: worst first. Postgres orders NULLs last under ASC, which
     * is the order this wants anyway — an unscored customer is not the worst
     * customer, it is an unanswered question, and it belongs after the answers.
     */
    index("idx_customer_health_assessments_score").on(t.organizationId, t.score),
    /** The composite tenant key the factor table points at. */
    unique("uniq_customer_health_assessments_org_id").on(
      t.organizationId,
      t.customerHealthAssessmentId,
    ),
  ],
);

/**
 * One input of one score, with everything needed to argue about it.
 *
 * A row per input rather than a `breakdown` jsonb blob — which is what
 * `client_health_scores` stores — for two reasons that only rows give you. A
 * blob cannot be queried ("which customers are unscored because nobody records
 * their activity"), and a blob cannot be constrained: the invariant that a
 * missing input has no value and a measured one has no reason is a CHECK here
 * and would be a convention there.
 *
 * The window is on the row because the inputs do not share one. Support and
 * sentiment are read over six months because tickets and surveys are sparse;
 * engagement and usage over three, because a quarter of silence is already the
 * answer. A score whose factors are reported without their windows invites the
 * reader to assume they share one.
 */
export const customerHealthFactors = pgTable(
  "customer_health_factors",
  {
    customerHealthFactorId: text("customer_health_factor_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    customerHealthAssessmentId: text("customer_health_assessment_id").notNull(),

    factorKey: text("factor_key").$type<HealthFactorKey>().notNull(),

    /** What this input is declared to be worth, before any input went missing. */
    weightBps: integer("weight_bps").notNull(),
    /**
     * What it was actually worth in this score, after the missing inputs' weight
     * was redistributed across the ones that spoke. Zero for a missing input.
     *
     * Both are stored because the difference is the interesting part: an input
     * declared at 2500 that carried 3800 of a particular score is doing more
     * work than the model says it should, and only the pair says so.
     */
    effectiveWeightBps: integer("effective_weight_bps").default(0).notNull(),

    status: text("status").$type<HealthFactorStatus>().notNull(),
    /** 0..100. NULL exactly when the input is missing — a CHECK enforces it. */
    value: integer("value"),
    /** NULL exactly when the input is measured. */
    missingReason: text("missing_reason").$type<HealthMissingReason>(),

    /**
     * `value * effective_weight_bps`, so the composite reconstructs exactly:
     * `score = round(sum(contribution_bps) / 10000)`.
     *
     * Stored rather than multiplied on read because rounding is where a
     * decomposition stops adding up, and a breakdown whose parts do not sum to
     * the whole is worse than no breakdown — it teaches the reader the number is
     * approximate when it is not.
     */
    contributionBps: integer("contribution_bps").default(0).notNull(),

    /** How many underlying observations the value was computed from. */
    observations: integer("observations").default(0).notNull(),

    windowDays: integer("window_days").notNull(),
    windowFrom: timestamp("window_from").notNull(),
    windowTo: timestamp("window_to").notNull(),

    /**
     * The raw counts behind the value — the layer below the decomposition.
     *
     * Scalars only, and never read to make a decision: this is what a person
     * looks at when they disagree with the number, which is the level at which
     * an argument about a health score is actually settled.
     */
    detail: jsonb("detail").$type<Record<string, number | null>>().default({}).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /**
     * One row per input per assessment, and the composite foreign key's own
     * delete-time lookup — one index serves both, tenant column leading.
     */
    uniqueIndex("uniq_customer_health_factors_key").on(
      t.organizationId,
      t.customerHealthAssessmentId,
      t.factorKey,
    ),
  ],
);

export type CustomerHealthAssessmentRow = typeof customerHealthAssessments.$inferSelect;
export type CustomerHealthFactorRow = typeof customerHealthFactors.$inferSelect;
