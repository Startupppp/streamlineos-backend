import { randomUUID } from "node:crypto";
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * What happens to a customer after the deal is won.
 *
 * Phase 6, tickets 07 to 09. Everything before this phase models the pursuit —
 * a lead, a deal, a stage, a close. The moment the deal closes, the CRM stops
 * having an opinion, and recurring revenue becomes visible only when somebody
 * notices it has already gone. These tables are the after.
 *
 * Three decisions shape the whole file.
 *
 * **The anchor is the Party, never a legacy account.** `client_accounts` is one
 * of five places a customer is recorded, and anchoring here would inherit that
 * fragmentation: two accounts for one company would be two lifecycles, two
 * renewal dates and two health scores that disagree. The party is the identity
 * the platform already converged on, so `uniq_customer_lifecycles_party` is what
 * makes "one customer, one lifecycle view" a database property rather than a
 * convention. The composite tenant foreign key onto
 * `business_parties (organization_id, party_id)` is the same edge `activities`
 * and `relationship_states` carry, and for the same reason: one organisation's
 * lifecycle must not be able to reference another's customer and still satisfy
 * referential integrity.
 *
 * **Signals and scores accumulate; nothing is overwritten.** The score table
 * this replaces recomputed with `DELETE ... WHERE org_id = $1` followed by an
 * `INSERT`, so it could only ever answer "what is the number now" — a customer
 * sliding from 80 to 45 over a quarter looked exactly like one that had always
 * been 45. A trend is the entire point of watching health, and a trend cannot be
 * derived from a table with one row per customer. Both `customer_health_scores`
 * and `customer_lifecycle_signals` are append-only, and the reads are
 * "newest first, limit n" rather than "the row".
 *
 * **A score stores its inputs and their weights, not its answer.** Exactly as a
 * commission entry stores `basisMinor`/`rateBps`/`splitBps`, `contributions`
 * holds every input with the weight it was given and whether it had any data at
 * all. A composite that cannot be decomposed is a number nobody can argue with,
 * and a number nobody can argue with is one nobody acts on.
 */

/**
 * Where a customer is in the arc after the win.
 *
 * Deliberately not `deals.stage`: a deal's stage is about a transaction and ends
 * at `WON`, and reusing it here would mean one column answering two questions
 * that diverge the moment a renewal opportunity opens beside a live contract.
 */
export const CUSTOMER_LIFECYCLE_STAGES = [
  "active",
  /** A renewal opportunity is open in the pipeline and somebody is working it. */
  "renewal_open",
  /** Health said something is wrong; an opportunity is open to save it. */
  "at_risk",
  "renewed",
  "churned",
] as const;
export type CustomerLifecycleStage = (typeof CUSTOMER_LIFECYCLE_STAGES)[number];

/** Stages nothing further happens from, so the trigger sweep skips them. */
export const TERMINAL_LIFECYCLE_STAGES: readonly CustomerLifecycleStage[] = [
  "renewed",
  "churned",
] as const;

/**
 * Where the contract term came from.
 *
 * A term is the one fact a won deal does not carry, and inventing twelve months
 * silently would put a renewal date on the calendar that nobody agreed to. The
 * column exists so a reader can tell a term the tenant stated from one the
 * platform assumed — the same rule ticket 08 applies to a missing score input.
 */
export const TERM_SOURCES = ["deal", "tenant", "default"] as const;
export type TermSource = (typeof TERM_SOURCES)[number];

/**
 * The bands, with the same three values the customer-executive surface reads.
 *
 * Renamed from "status" to "band" here because the word is doing a different
 * job — this is where a score falls, not what state a record is in — but the
 * values are unchanged on purpose: `client_health_status` already holds these,
 * every existing reader compares against them, and a fourth spelling of
 * "at risk" is the kind of change that costs a week and buys nothing.
 */
export const CUSTOMER_HEALTH_BANDS = ["healthy", "at_risk", "critical"] as const;
export type CustomerHealthBand = (typeof CUSTOMER_HEALTH_BANDS)[number];

/**
 * The four things health is made of, plus the clock.
 *
 * `usage` is the tenant's own product telemetry and is absent for most of them;
 * `engagement` is the unified timeline; `support` is ticket history; `sentiment`
 * is what conversation analysis concluded. `renewal` is here because the
 * configuration that already exists weights it, and dropping it would silently
 * reweight every tenant's score on deploy day.
 */
export const HEALTH_INPUTS = [
  "usage",
  "engagement",
  "support",
  "sentiment",
  "renewal",
] as const;
export type HealthInput = (typeof HEALTH_INPUTS)[number];

/**
 * One input's contribution to a score, stored rather than derived.
 *
 * `scoreBps` is basis points, not a percentage, so the composite can be rounded
 * once at the end over the whole set instead of accumulating a point of drift
 * per input. `available: false` with a null score is the shape of an absence —
 * never a zero, because an input scored as zero is indistinguishable from an
 * input that was measured and came back terrible, and that difference is the
 * whole of ticket 08's third criterion.
 */
export interface HealthContribution {
  readonly input: HealthInput;
  /** The weight this input was given, in basis points of the declared total. */
  readonly weightBps: number;
  /** 0..10000, or null when nothing was there to measure. */
  readonly scoreBps: number | null;
  readonly available: boolean;
  /** The facts this input's own score came out of, so a reader can disagree. */
  readonly evidence: Readonly<Record<string, string | number | null>>;
}

/** Whether the composite saw everything it declared it wanted. */
export const HEALTH_BASES = ["complete", "partial"] as const;
export type HealthBasis = (typeof HEALTH_BASES)[number];

/**
 * What changed about a customer that changes what the account is.
 *
 * The vocabulary mirrors `relationship-signals.ts` rather than restating it: a
 * signal is a kind, the evidence behind it, how reversible acting on it is and
 * one line for the feed. A second notion of "signal" with its own fields is how
 * two review surfaces end up disagreeing about what the system noticed.
 */
export const CUSTOMER_LIFECYCLE_SIGNAL_KINDS = [
  "lifecycle.opened",
  "health.dropped",
  "health.recovered",
  "health.band-changed",
  "renewal.window-opened",
  "churn.risk-raised",
] as const;
export type CustomerLifecycleSignalKind = (typeof CUSTOMER_LIFECYCLE_SIGNAL_KINDS)[number];

export const customerLifecycles = pgTable(
  "customer_lifecycles",
  {
    customerLifecycleId: text("customer_lifecycle_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    /** The customer. One row per party per tenant — see the unique index. */
    partyId: text("party_id").notNull(),

    /**
     * The won deal this came out of, as text and with no foreign key.
     *
     * Exactly what `activities.deal_id` and `relationship_states.deal_id` do,
     * and for the identical reason: `deals.id` is an integer, the go-forward
     * model stores whatever the anchor said it was, and a cascade from a deleted
     * deal must not take a live contract's record with it.
     */
    originDealId: text("origin_deal_id"),

    stage: text("stage").$type<CustomerLifecycleStage>().default("active").notNull(),

    /** How long the contract runs. Months, because that is how terms are sold. */
    termMonths: integer("term_months").notNull(),
    termSource: text("term_source").$type<TermSource>().notNull(),

    /** Integer minor units, platform-wide. A decimal here is drift on a sum. */
    contractValueMinor: bigint("contract_value_minor", { mode: "number" })
      .default(0)
      .notNull(),
    currencyCode: text("currency_code").notNull(),

    startedAt: timestamp("started_at").notNull(),
    /**
     * A date rather than a timestamp, and read as UTC midnight everywhere.
     *
     * Contracts renew on a day, not at an instant, and the legacy health service
     * parsed its renewal date at LOCAL midnight — so the same contract was a day
     * closer to renewal depending on which region the process happened to run
     * in. A date column plus one parsing rule removes the question.
     */
    renewalDate: date("renewal_date").notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /** Criterion 3: one customer, one lifecycle view. */
    uniqueIndex("uniq_customer_lifecycles_party").on(t.organizationId, t.partyId),
    /** The trigger sweep: what renews soonest, tenant by tenant. */
    index("idx_customer_lifecycles_renewal").on(t.organizationId, t.renewalDate),
    index("idx_customer_lifecycles_stage").on(t.organizationId, t.stage, t.renewalDate),
    /** The composite tenant key the two child tables point at. */
    unique("uniq_customer_lifecycles_org_id").on(t.organizationId, t.customerLifecycleId),
  ],
);

/**
 * Everything the system noticed about a customer, in the order it noticed it.
 *
 * Append-only, and that is criterion 4 rather than a storage preference: a
 * current-state column can say a customer is at risk and can never say they
 * have been at risk three times this year and recovered twice, which is a
 * different account and a different conversation.
 */
export const customerLifecycleSignals = pgTable(
  "customer_lifecycle_signals",
  {
    customerLifecycleSignalId: text("customer_lifecycle_signal_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    customerLifecycleId: text("customer_lifecycle_id").notNull(),
    /** Denormalised from the lifecycle so a party's signals read without a join. */
    partyId: text("party_id").notNull(),

    kind: text("kind").$type<CustomerLifecycleSignalKind>().notNull(),
    /**
     * Named values, never a sentence.
     *
     * A reason string is unreadable by anything but a person, and these are what
     * a reviewer disagrees with when they think the system got it wrong.
     */
    evidence: jsonb("evidence").$type<Record<string, string | number | null>>().notNull(),
    /** `instant` or `hold`, the same two words `decision-record.ts` uses. */
    reversibility: text("reversibility").notNull(),
    summary: text("summary").notNull(),

    /** When the thing happened, which is not when the sweep noticed it. */
    observedAt: timestamp("observed_at").defaultNow().notNull(),
  },
  (t) => [
    /** The history read: one customer's signals, newest first. */
    index("idx_customer_lifecycle_signals_history").on(
      t.organizationId,
      t.customerLifecycleId,
      t.observedAt,
    ),
    index("idx_customer_lifecycle_signals_party").on(t.organizationId, t.partyId, t.observedAt),
  ],
);

/**
 * Every score ever computed, with the inputs it was computed from.
 *
 * Replaces `client_health_scores`, which this supersedes rather than sits beside:
 * that table was anchored to `client_accounts` and was truncated on every
 * recompute. Nothing writes it after this ships.
 */
export const customerHealthScores = pgTable(
  "customer_health_scores",
  {
    customerHealthScoreId: text("customer_health_score_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    partyId: text("party_id").notNull(),
    /**
     * Nullable, because health does not wait for a contract.
     *
     * A customer can be scored from their timeline and their tickets long before
     * anybody records a term and a renewal date, and refusing to score them
     * until then would make the surface empty for exactly the tenants who have
     * not adopted lifecycles yet.
     */
    customerLifecycleId: text("customer_lifecycle_id"),

    /** 0..100, rounded once, at the end, over the whole weighted set. */
    score: integer("score").notNull(),
    band: text("band").$type<CustomerHealthBand>().notNull(),

    contributions: jsonb("contributions").$type<HealthContribution[]>().notNull(),
    /**
     * How much of the declared weight had data behind it, in basis points.
     *
     * The label criterion 3 asks for, as a number rather than a sentence: 10000
     * means every input was measured, 4000 means the score is an honest reading
     * of two fifths of the model. Two scores with different coverage are not
     * comparable, which is what stops a signal firing when an input merely went
     * quiet — see `healthSignals` in `customer-lifecycle/health-score.ts`.
     */
    coverageBps: integer("coverage_bps").notNull(),
    basis: text("basis").$type<HealthBasis>().notNull(),

    computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (t) => [
    /** The trend read: one customer's scores, newest first. */
    index("idx_customer_health_scores_history").on(t.organizationId, t.partyId, t.computedAt),
    /** The at-risk sweep: worst first, for a tenant. */
    index("idx_customer_health_scores_band").on(t.organizationId, t.band, t.computedAt),
  ],
);

/**
 * Usage, where the tenant supplies it — and nowhere else.
 *
 * This is the seam ticket 08's first criterion needs and the platform did not
 * have: product telemetry lives in the tenant's own system, and the CRM has no
 * way to invent it. A tenant posts observations here in whatever units their
 * product counts in, together with what they consider a full one, and the
 * scoring reads the ratio. A tenant that posts nothing is not unhealthy — they
 * are unmeasured, and `contributions` says so.
 *
 * `expected_value` is the denominator the TENANT chose. A platform-chosen
 * benchmark would be the same lie as a platform-chosen zero: nobody outside the
 * tenant knows what "enough logins" is for their product.
 */
export const customerUsageObservations = pgTable(
  "customer_usage_observations",
  {
    customerUsageObservationId: text("customer_usage_observation_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    partyId: text("party_id").notNull(),

    /** The tenant's own name for what they counted — `weekly_active_seats`. */
    metricKey: text("metric_key").notNull(),
    observedValue: bigint("observed_value", { mode: "number" }).notNull(),
    /** What the tenant considers full use of the thing they sold. */
    expectedValue: bigint("expected_value", { mode: "number" }).notNull(),

    observedAt: timestamp("observed_at").notNull(),
    /** Which integration or upload produced it, for when a number looks wrong. */
    source: text("source").default("api").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /** The scoring read: the latest observation of each metric for a customer. */
    index("idx_customer_usage_observations_latest").on(
      t.organizationId,
      t.partyId,
      t.metricKey,
      t.observedAt,
    ),
    /**
     * One observation per metric per instant.
     *
     * A tenant re-posting the same period is correcting it, not adding to it,
     * and without this the mean over "the latest observation" would quietly
     * become a mean over however many times their job retried.
     */
    uniqueIndex("uniq_customer_usage_observations_point").on(
      t.organizationId,
      t.partyId,
      t.metricKey,
      t.observedAt,
    ),
  ],
);
