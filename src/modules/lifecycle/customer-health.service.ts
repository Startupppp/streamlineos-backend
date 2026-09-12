import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties } from "../../db/schema/party";
import { customerHealthAssessments, customerHealthFactors } from "../../db/schema/crm/lifecycle";
import { HEALTH_WINDOW_DAYS, healthWindow } from "./health-factors";
import {
  DEFAULT_HEALTH_WEIGHTS_BPS,
  HEALTH_WEIGHTS_VERSION,
  compositeHealth,
  type HealthComposite,
} from "./health-score";
import type { CustomerHealthRosterQuery } from "./dto/health.schemas";
import type { HealthAssessmentView } from "./customer-health.types";
import { persistAssessment } from "./lib/customer-health-persist";
import { readEngagement, readSentiment, readSupport, readUsage } from "./lib/customer-health-readers";
import { sourcesInUse } from "./lib/customer-health-sources";

export type { HealthAssessmentView } from "./customer-health.types";

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

@Injectable()
export class CustomerHealthService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // The source probes and reads live in `lib/customer-health-sources.ts` and
  // `lib/customer-health-readers.ts`; the transactional write-back in
  // `lib/customer-health-persist.ts`. Each takes this service's handle.

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

    const sources = await sourcesInUse(this.db, organizationId);

    const [engagement, support, sentiment, usage] = await Promise.all([
      readEngagement(this.db, organizationId, partyId, windows.engagement, sources.engagement),
      readSupport(this.db, organizationId, partyId, windows.support, sources.support),
      readSentiment(this.db, organizationId, partyId, windows.sentiment, sources.sentiment),
      readUsage(this.db, organizationId, partyId, windows.usage, sources.usage),
    ]);

    const composite = compositeHealth(
      [usage, engagement, support, sentiment],
      HEALTH_WEIGHTS_VERSION,
    );

    const stored = await persistAssessment(this.db, organizationId, partyId, composite, asOf);

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
