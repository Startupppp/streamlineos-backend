import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties } from "../../db/schema/party";
import { activities } from "../../db/schema/crm/activities";
import { supportTickets } from "../../db/schema/support/tickets";
import { supportAiSuggestions } from "../../db/schema/support/support-ai";
import {
  customerHealthAssessments,
  customerHealthFactors,
  customerLifecycleSignals,
  customerLifecycles,
} from "../../db/schema/crm/lifecycle";
import {
  HEALTH_WINDOW_DAYS,
  engagementFactor,
  healthWindow,
  sentimentFactor,
  supportFactor,
  usageFactor,
} from "./health-factors";
import {
  DEFAULT_HEALTH_WEIGHTS_BPS,
  HEALTH_WEIGHTS_VERSION,
  compositeHealth,
  type HealthComposite,
  type HealthFactor,
} from "./health-score";
import type { CustomerHealthRosterQuery } from "./dto/health.schemas";

/**
 * Counting the rows a health score is made of, and storing the answer so it can
 * be argued with.
 *
 * The judgement is not here. `health-factors.ts` decides what a count means and
 * `health-score.ts` decides how the four combine; this file only knows which
 * tables hold the observations and how to write the result down. Keeping the
 * split honest is what makes the model exercisable without a database, and the
 * reason `cs-health.service.ts` — where the same arithmetic is interleaved with
 * the queries — has no test of its scoring rules at all.
 *
 * Every query carries the organisation predicate explicitly. RLS is the
 * backstop; a health score names which of a tenant's customers are about to
 * leave, which is among the most disclosive data in the product.
 *
 * On the write-back to `business_parties`: the assessment table is the record
 * and the party columns are a projection of it, so anything that edits
 * `business_parties.health_score` by hand is overwritten at the next recompute.
 * That is the intended direction. A composite that can be hand-edited is a
 * composite whose factor rows no longer explain it, which is the same defect as
 * storing no factors at all.
 */

/** The three probes and four aggregates a single assessment needs. */
interface SourceAvailability {
  readonly engagement: boolean;
  readonly support: boolean;
  readonly sentiment: boolean;
  readonly usage: boolean;
}

@Injectable()
export class CustomerHealthService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // ── Computing ─────────────────────────────────────────────────────────────

  /**
   * Recomputes one customer's health from its sources and stores the result
   * with every input that produced it.
   *
   * Per customer rather than per organisation, unlike `computeHealthForOrg`,
   * which recomputes every client account in the tenant in one pass and deletes
   * the whole score table to do it. That shape cannot be triggered from a
   * customer's own screen without recomputing everybody, so in practice it is
   * only ever as fresh as the last cron run — and a health score nobody can
   * refresh while looking at it is a health score nobody believes.
   */
  async assess(
    organizationId: string,
    partyId: string,
    asOf: Date = new Date(),
  ): Promise<{ data: HealthAssessmentView }> {
    const party = await this.loadParty(organizationId, partyId);

    const windows = {
      usage: healthWindow(HEALTH_WINDOW_DAYS.usage, asOf),
      engagement: healthWindow(HEALTH_WINDOW_DAYS.engagement, asOf),
      support: healthWindow(HEALTH_WINDOW_DAYS.support, asOf),
      sentiment: healthWindow(HEALTH_WINDOW_DAYS.sentiment, asOf),
    };

    const sources = await this.sourcesInUse(organizationId);

    const [engagement, support, sentiment, usage] = await Promise.all([
      this.engagement(organizationId, partyId, windows.engagement, sources.engagement),
      this.support(organizationId, partyId, windows.support, sources.support),
      this.sentiment(organizationId, partyId, windows.sentiment, sources.sentiment),
      this.usage(organizationId, partyId, windows.usage, sources.usage),
    ]);

    const composite = compositeHealth(
      [usage, engagement, support, sentiment],
      HEALTH_WEIGHTS_VERSION,
    );

    const stored = await this.persist(organizationId, partyId, composite, asOf);

    return {
      data: {
        partyId,
        partyName: party.name,
        customerHealthAssessmentId: stored.customerHealthAssessmentId,
        computedAt: stored.computedAt,
        ...view(composite),
      },
    };
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /**
   * The stored assessment and its inputs.
   *
   * 404 when a customer has never been assessed, rather than computing one on
   * the way past. A GET that writes four tables is a GET a retry storm can turn
   * into a write storm, and — worse here — it would mean two people reading the
   * same customer's health on the same afternoon could see different numbers
   * with no record of why.
   */
  async get(organizationId: string, partyId: string) {
    const [assessment] = await this.db
      .select({
        customerHealthAssessmentId:
          customerHealthAssessments.customerHealthAssessmentId,
        partyId: customerHealthAssessments.partyId,
        partyName: businessParties.name,
        score: customerHealthAssessments.score,
        healthStatus: customerHealthAssessments.healthStatus,
        coverageBps: customerHealthAssessments.coverageBps,
        weightsVersion: customerHealthAssessments.weightsVersion,
        computedAt: customerHealthAssessments.computedAt,
      })
      .from(customerHealthAssessments)
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.partyId, customerHealthAssessments.partyId),
          eq(businessParties.organizationId, customerHealthAssessments.organizationId),
        ),
      )
      .where(
        and(
          eq(customerHealthAssessments.organizationId, organizationId),
          eq(customerHealthAssessments.partyId, partyId),
        ),
      )
      .limit(1);

    if (!assessment) {
      throw new NotFoundException(
        "This customer has no health assessment yet; POST .../recompute to produce one",
      );
    }

    const factors = await this.db
      .select({
        factorKey: customerHealthFactors.factorKey,
        weightBps: customerHealthFactors.weightBps,
        effectiveWeightBps: customerHealthFactors.effectiveWeightBps,
        status: customerHealthFactors.status,
        value: customerHealthFactors.value,
        missingReason: customerHealthFactors.missingReason,
        contributionBps: customerHealthFactors.contributionBps,
        observations: customerHealthFactors.observations,
        windowDays: customerHealthFactors.windowDays,
        windowFrom: customerHealthFactors.windowFrom,
        windowTo: customerHealthFactors.windowTo,
        detail: customerHealthFactors.detail,
      })
      .from(customerHealthFactors)
      .where(
        and(
          eq(customerHealthFactors.organizationId, organizationId),
          eq(
            customerHealthFactors.customerHealthAssessmentId,
            assessment.customerHealthAssessmentId,
          ),
        ),
      );

    return { data: { ...assessment, factors } };
  }

  /**
   * The roster: worst first, unscored last.
   *
   * Ordered on the stored score rather than a recomputed one, which is the only
   * reason the score is materialised at all — an order-by over a value computed
   * per row reads every customer of the tenant to return fifty.
   */
  async roster(organizationId: string, query: CustomerHealthRosterQuery) {
    const conditions = [eq(customerHealthAssessments.organizationId, organizationId)];
    if (query.band) {
      conditions.push(eq(customerHealthAssessments.healthStatus, query.band));
    }
    if (query.unscored === true) {
      conditions.push(isNull(customerHealthAssessments.score));
    }

    const rows = await this.db
      .select({
        customerHealthAssessmentId:
          customerHealthAssessments.customerHealthAssessmentId,
        partyId: customerHealthAssessments.partyId,
        partyName: businessParties.name,
        score: customerHealthAssessments.score,
        healthStatus: customerHealthAssessments.healthStatus,
        coverageBps: customerHealthAssessments.coverageBps,
        weightsVersion: customerHealthAssessments.weightsVersion,
        computedAt: customerHealthAssessments.computedAt,
      })
      .from(customerHealthAssessments)
      /**
       * Left, and tenant-matched on both columns — the same shape
       * `lifecycle.service.ts` uses and for the same two reasons: a party that
       * has been removed must not make its health disappear from the roster, and
       * the composite match is what stops a tampered `party_id` reaching another
       * organisation's customer name.
       */
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.partyId, customerHealthAssessments.partyId),
          eq(businessParties.organizationId, customerHealthAssessments.organizationId),
        ),
      )
      .where(and(...conditions))
      /**
       * Postgres sorts NULLs last under ASC, which is the order this wants: an
       * unscored customer is an unanswered question rather than the worst
       * answer, and putting them at the top would bury the customers the model
       * actually did score badly.
       */
      .orderBy(asc(customerHealthAssessments.score), asc(customerHealthAssessments.partyId))
      .limit(query.limit)
      .offset(query.offset);

    return { data: rows };
  }

  // ── The sources ───────────────────────────────────────────────────────────

  /**
   * Whether each source is in use by this organisation AT ALL.
   *
   * This is the question that decides whether an empty result is a measurement
   * or a gap, and it has to be asked organisation-wide rather than per customer:
   * "this customer has no activity" means silence in a tenant that logs
   * activities and means nothing whatsoever in a tenant that does not. Getting
   * this backwards would drop every customer of every tenant that has not
   * adopted the timeline straight into the critical band.
   *
   * Each probe requires the anchor as well as the row — an activity with no
   * `party_id`, or a ticket with no `client_party_id`, can never be counted
   * against a customer, so a tenant with a million of them still has no usable
   * source and must be told so.
   */
  private async sourcesInUse(organizationId: string): Promise<SourceAvailability> {
    const [engagement, support, sentiment, usage] = await Promise.all([
      this.db
        .select({ present: sql<number>`1` })
        .from(activities)
        .where(
          and(
            eq(activities.organizationId, organizationId),
            isNotNull(activities.partyId),
            isNull(activities.deletedAt),
          ),
        )
        .limit(1),
      this.db
        .select({ present: sql<number>`1` })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.orgId, organizationId),
            isNotNull(supportTickets.clientPartyId),
          ),
        )
        .limit(1),
      this.db
        .select({ present: sql<number>`1` })
        .from(supportAiSuggestions)
        .innerJoin(
          supportTickets,
          and(
            eq(supportTickets.id, supportAiSuggestions.ticketId),
            eq(supportTickets.orgId, supportAiSuggestions.orgId),
          ),
        )
        .where(
          and(
            eq(supportAiSuggestions.orgId, organizationId),
            eq(supportAiSuggestions.type, "sentiment"),
            isNotNull(supportTickets.clientPartyId),
          ),
        )
        .limit(1),
      this.db
        .select({ present: sql<number>`1` })
        .from(customerLifecycleSignals)
        .where(
          and(
            eq(customerLifecycleSignals.organizationId, organizationId),
            eq(customerLifecycleSignals.kind, "usage-decline"),
          ),
        )
        .limit(1),
    ]);

    return {
      engagement: engagement.length > 0,
      support: support.length > 0,
      sentiment: sentiment.length > 0,
      usage: usage.length > 0,
    };
  }

  /**
   * Engagement, from the unified timeline.
   *
   * One query over the party's whole timeline rather than two: the window counts
   * come back as FILTERed aggregates and the last-contact date as an unfiltered
   * `max`, because the recency term has to see contact that predates the window
   * — a customer last spoken to on day 91 and one never spoken to at all are not
   * the same customer, and two separate windowed queries could not tell them
   * apart.
   */
  private async engagement(
    organizationId: string,
    partyId: string,
    window: ReturnType<typeof healthWindow>,
    sourceInUse: boolean,
  ): Promise<HealthFactor> {
    const [row] = await this.db
      .select({
        activityCount: sql<number>`count(*) FILTER (WHERE ${activities.occurredAt} >= ${window.from})::int`,
        /**
         * Distinct days, not rows. An ingested mail thread writes dozens of rows
         * in one second and counting them would score an import as a quarter of
         * daily contact.
         */
        contactDays: sql<number>`count(DISTINCT date(${activities.occurredAt})) FILTER (WHERE ${activities.occurredAt} >= ${window.from})::int`,
        lastActivityAt: sql<Date | null>`max(${activities.occurredAt})`,
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.partyId, partyId),
          isNull(activities.deletedAt),
        ),
      );

    return engagementFactor(
      {
        sourceInUse,
        activityCount: row?.activityCount ?? 0,
        contactDays: row?.contactDays ?? 0,
        lastActivityAt: coerceDate(row?.lastActivityAt ?? null),
      },
      window,
    );
  }

  /**
   * Support history, from the helpdesk.
   *
   * `client_party_id` rather than `client_id`: the legacy column is an id into a
   * table the party model replaced, and reading it would double-count any
   * customer whose two legacy records were merged into one Party while missing
   * every ticket raised since the backfill.
   *
   * A breach is counted against the SLA deadline in both directions — resolved
   * late, or still open past it — because a ticket that has been open for three
   * weeks past its commitment is the worst case and would otherwise be the only
   * one this misses.
   */
  private async support(
    organizationId: string,
    partyId: string,
    window: ReturnType<typeof healthWindow>,
    sourceInUse: boolean,
  ): Promise<HealthFactor> {
    const [row] = await this.db
      .select({
        opened: sql<number>`count(*) FILTER (WHERE ${supportTickets.createdAt} >= ${window.from})::int`,
        urgent: sql<number>`count(*) FILTER (WHERE ${supportTickets.createdAt} >= ${window.from} AND ${supportTickets.priority} IN ('HIGH', 'URGENT'))::int`,
        slaBreached: sql<number>`count(*) FILTER (
          WHERE ${supportTickets.createdAt} >= ${window.from}
            AND ${supportTickets.slaDeadline} IS NOT NULL
            AND (
              (${supportTickets.resolvedAt} IS NOT NULL AND ${supportTickets.resolvedAt} > ${supportTickets.slaDeadline})
              OR (${supportTickets.resolvedAt} IS NULL AND ${supportTickets.slaDeadline} < ${window.to})
            )
        )::int`,
        openNow: sql<number>`count(*) FILTER (WHERE ${supportTickets.status} NOT IN ('RESOLVED', 'CLOSED'))::int`,
      })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.orgId, organizationId),
          eq(supportTickets.clientPartyId, partyId),
        ),
      );

    return supportFactor(
      {
        sourceInUse,
        opened: row?.opened ?? 0,
        urgent: row?.urgent ?? 0,
        slaBreached: row?.slaBreached ?? 0,
        openNow: row?.openNow ?? 0,
      },
      window,
    );
  }

  /**
   * Conversation sentiment, from the support triage the AI already runs.
   *
   * `status <> 'rejected'` is load-bearing: a rejected suggestion is one a human
   * looked at and said was wrong, and counting it would mean the model's own
   * mistakes keep scoring a customer after somebody corrected them.
   *
   * `observedEver` is carried separately from the windowed counts so the factor
   * can tell "never analysed" from "analysed, all of it older than the window".
   * Those are different gaps: one is fixed by asking the customer something, the
   * other by noticing that nobody has in six months.
   */
  private async sentiment(
    organizationId: string,
    partyId: string,
    window: ReturnType<typeof healthWindow>,
    sourceInUse: boolean,
  ): Promise<HealthFactor> {
    const verdict = sql`${supportAiSuggestions.payload}->>'sentiment'`;
    const inWindow = sql`${supportAiSuggestions.createdAt} >= ${window.from}`;

    const [row] = await this.db
      .select({
        positive: sql<number>`count(*) FILTER (WHERE ${inWindow} AND ${verdict} = 'positive')::int`,
        neutral: sql<number>`count(*) FILTER (WHERE ${inWindow} AND ${verdict} = 'neutral')::int`,
        negative: sql<number>`count(*) FILTER (WHERE ${inWindow} AND ${verdict} = 'negative')::int`,
        everCount: sql<number>`count(*)::int`,
      })
      .from(supportAiSuggestions)
      .innerJoin(
        supportTickets,
        and(
          eq(supportTickets.id, supportAiSuggestions.ticketId),
          eq(supportTickets.orgId, supportAiSuggestions.orgId),
        ),
      )
      .where(
        and(
          eq(supportAiSuggestions.orgId, organizationId),
          eq(supportAiSuggestions.type, "sentiment"),
          sql`${supportAiSuggestions.status} <> 'rejected'`,
          eq(supportTickets.clientPartyId, partyId),
        ),
      );

    return sentimentFactor(
      {
        sourceInUse,
        positive: row?.positive ?? 0,
        neutral: row?.neutral ?? 0,
        negative: row?.negative ?? 0,
        observedEver: (row?.everCount ?? 0) > 0,
      },
      window,
    );
  }

  /**
   * Usage, from the only per-customer usage fact this system holds.
   *
   * A `usage-decline` lifecycle signal, joined through the customer's contracts.
   * See `usageFactor` for why this is a weak source and why saying so is better
   * than substituting a number: there is no product telemetry in this schema,
   * and a customer nobody has observed must not be scored as one observed to be
   * fine.
   */
  private async usage(
    organizationId: string,
    partyId: string,
    window: ReturnType<typeof healthWindow>,
    sourceInUse: boolean,
  ): Promise<HealthFactor> {
    const [row] = await this.db
      .select({
        observationCount: sql<number>`count(*) FILTER (WHERE ${customerLifecycleSignals.observedAt} >= ${window.from})::int`,
        declineImpact: sql<number>`coalesce(sum(${customerLifecycleSignals.impact}) FILTER (WHERE ${customerLifecycleSignals.observedAt} >= ${window.from}), 0)::int`,
        everCount: sql<number>`count(*)::int`,
      })
      .from(customerLifecycleSignals)
      /**
       * An explicit join rather than the relational include API, and tenant
       * matched on both columns. The signal table carries no `party_id` of its
       * own — the contract does — so this is the edge that turns "evidence about
       * a contract" into "evidence about a customer".
       */
      .innerJoin(
        customerLifecycles,
        and(
          eq(
            customerLifecycles.customerLifecycleId,
            customerLifecycleSignals.customerLifecycleId,
          ),
          eq(
            customerLifecycles.organizationId,
            customerLifecycleSignals.organizationId,
          ),
        ),
      )
      .where(
        and(
          eq(customerLifecycleSignals.organizationId, organizationId),
          eq(customerLifecycleSignals.kind, "usage-decline"),
          eq(customerLifecycles.partyId, partyId),
        ),
      );

    return usageFactor(
      {
        sourceInUse,
        observationCount: row?.observationCount ?? 0,
        declineImpact: row?.declineImpact ?? 0,
        observedEver: (row?.everCount ?? 0) > 0,
      },
      window,
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async loadParty(organizationId: string, partyId: string) {
    const [party] = await this.db
      .select({ partyId: businessParties.partyId, name: businessParties.name })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          eq(businessParties.partyId, partyId),
        ),
      )
      .limit(1);

    /** 404 rather than 403: a 403 would confirm another tenant's customer exists. */
    if (!party) throw new NotFoundException("Customer not found");
    return party;
  }

  /**
   * Writes the score, its inputs and the party projection in one transaction.
   *
   * One transaction because a score without its factors is exactly the thing
   * this feature exists to stop existing — a number nobody can take apart — and
   * a partial write would produce one. The factor rows are deleted and rewritten
   * rather than upserted per key so that a factor set which changes shape (a
   * fifth input, or one retired) cannot leave an orphan row from the old model
   * in a decomposition of the new one.
   */
  private async persist(
    organizationId: string,
    partyId: string,
    composite: HealthComposite,
    asOf: Date,
  ) {
    return this.db.transaction(async (tx) => {
      const db = tx as Db;

      const [assessment] = await db
        .insert(customerHealthAssessments)
        .values({
          organizationId,
          partyId,
          score: composite.score,
          healthStatus: composite.band,
          coverageBps: composite.coverageBps,
          weightsVersion: composite.weightsVersion,
          computedAt: asOf,
        })
        .onConflictDoUpdate({
          target: [
            customerHealthAssessments.organizationId,
            customerHealthAssessments.partyId,
          ],
          set: {
            score: composite.score,
            healthStatus: composite.band,
            coverageBps: composite.coverageBps,
            weightsVersion: composite.weightsVersion,
            computedAt: asOf,
            updatedAt: asOf,
          },
        })
        .returning({
          customerHealthAssessmentId:
            customerHealthAssessments.customerHealthAssessmentId,
          computedAt: customerHealthAssessments.computedAt,
        });

      if (!assessment) throw new NotFoundException("Health assessment could not be stored");

      await db
        .delete(customerHealthFactors)
        .where(
          and(
            eq(customerHealthFactors.organizationId, organizationId),
            eq(
              customerHealthFactors.customerHealthAssessmentId,
              assessment.customerHealthAssessmentId,
            ),
          ),
        );

      await db.insert(customerHealthFactors).values(
        composite.factors.map((factor) => ({
          organizationId,
          customerHealthAssessmentId: assessment.customerHealthAssessmentId,
          factorKey: factor.key,
          weightBps: factor.weightBps,
          effectiveWeightBps: factor.effectiveWeightBps,
          status: factor.status,
          /**
           * Null for a missing input, never zero. The column's CHECK enforces
           * the same invariant from the other side, so a producer that bypassed
           * this service still cannot file a missing input as a scored one.
           */
          value: factor.status === "measured" ? factor.value : null,
          missingReason: factor.status === "missing" ? factor.reason : null,
          contributionBps: factor.contributionBps,
          observations: factor.status === "measured" ? factor.observations : 0,
          windowDays: factor.window.days,
          windowFrom: factor.window.from,
          windowTo: factor.window.to,
          detail: factor.detail,
        })),
      );

      /**
       * The projection onto the party. Null score and null status when the model
       * could not answer — carried all the way out rather than rounded into a
       * number, because `business_parties.health_score` is already nullable for
       * exactly this reason and every surface that reads it already handles it.
       */
      await db
        .update(businessParties)
        .set({
          healthScore: composite.score,
          healthStatus: composite.band,
          healthCheckedAt: asOf,
        })
        .where(
          and(
            eq(businessParties.organizationId, organizationId),
            eq(businessParties.partyId, partyId),
          ),
        );

      return assessment;
    });
  }
}

/** What a computed assessment looks like on the wire. */
export interface HealthAssessmentView {
  readonly partyId: string;
  readonly partyName: string | null;
  readonly customerHealthAssessmentId: string;
  readonly computedAt: Date;
  readonly score: number | null;
  readonly band: string | null;
  readonly coverageBps: number;
  readonly weightsVersion: number;
  readonly weightsBps: Readonly<Record<string, number>>;
  readonly factors: HealthComposite["factors"];
  readonly unscored: HealthComposite["unscored"];
}

/**
 * The composite, plus the declared weight table it was scored against.
 *
 * The weights ship with the answer rather than being looked up by the reader,
 * because "why is this 61" is unanswerable without them — the effective weights
 * on the factors are post-redistribution, and the difference between declared
 * and effective is the part that surprises people.
 */
function view(composite: HealthComposite) {
  return {
    score: composite.score,
    band: composite.band,
    coverageBps: composite.coverageBps,
    weightsVersion: composite.weightsVersion,
    weightsBps: DEFAULT_HEALTH_WEIGHTS_BPS,
    factors: composite.factors,
    unscored: composite.unscored,
  };
}

/**
 * `max(timestamp)` comes back as a `Date` from the driver and as a string from
 * some paths; normalised here rather than trusted, because an unparsed string
 * arithmetic'd against a `Date` yields `NaN` days and a silent zero for recency.
 */
function coerceDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
