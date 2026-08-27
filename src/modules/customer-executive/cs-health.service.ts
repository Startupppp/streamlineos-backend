import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  activities,
  clientAccounts,
  healthScoreConfig,
  supportAiSuggestions,
  supportTickets,
  type HealthScoreBreakdown,
  type HealthScoreThresholds,
  type HealthScoreWeights,
} from "../../db/schema";
import {
  customerHealthScores,
  customerLifecycleSignals,
  customerLifecycles,
  customerUsageObservations,
  type CustomerHealthBand,
  type HealthBasis,
  type HealthContribution,
  type HealthInput,
} from "../../db/schema/crm/customer-lifecycle";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { daysUntil } from "../customer-lifecycle/lifecycle-record";
import {
  availableInputsOf,
  healthSignals,
  healthTrend,
  healthWeightsFromConfig,
  scoreHealth,
  USAGE_FRESHNESS_DAYS,
  type HealthPoint,
  type SupportTicketFact,
  type UsageObservation,
} from "../customer-lifecycle/health-score";

/**
 * Customer health, gathered from the record and scored by the rules.
 *
 * Phase 6, ticket 08. This service used to hold the arithmetic as well as the
 * reads, and it was wrong in three ways that the rewrite exists to fix rather
 * than work around.
 *
 * **It had no history.** Recompute was `DELETE ... WHERE org_id = $1` followed by
 * an `INSERT`, so the table could only ever answer "what is the number now". A
 * customer sliding from 80 to 45 over a quarter was indistinguishable from one
 * that had always been 45, and a trend — the entire reason anybody watches health
 * — could not be computed at all. Writes are append-only now, and there is no
 * delete anywhere in this file.
 *
 * **It was anchored to `client_accounts`.** That is one of five places this
 * platform records a customer, so two accounts for one company were two health
 * scores that could disagree. Scores are written against the Party, which is the
 * identity everything else converged on; accounts are resolved to their party on
 * the way in and mapped back on the way out, so every existing caller of this
 * service sees the shape it always saw.
 *
 * **It fabricated the inputs it did not have.** A missing input scored a neutral
 * fifty, and the SLA and ticket figures were computed once for the whole
 * ORGANISATION and written onto every account — so every customer of a tenant
 * with one bad week scored identically on two fifths of the model. Inputs are per
 * party now, and an input with no data is absent rather than invented;
 * `coverageBps` says how much of the model was behind the number.
 *
 * Every rule lives in `customer-lifecycle/health-score.ts`. This file finds
 * facts, calls them, and writes what came back — the weights and thresholds a
 * tenant configured still drive it, through `healthWeightsFromConfig`.
 */

const DAY_MS = 86_400_000;

/** The engagement window, and the window before it that momentum compares against. */
const ENGAGEMENT_WINDOW_DAYS = 90;
/** How much support history counts. Older than this describes a different account team. */
const SUPPORT_WINDOW_DAYS = 180;

/**
 * Bounds on the fact-gathering reads.
 *
 * The service this replaces had none: it read every ticket and every CSAT
 * response a tenant had ever recorded on every recompute. A bound is the fix,
 * and the reads below are ordered so that the bound truncates deterministically
 * — an unordered LIMIT scores a different five hundred customers each run, which
 * is worse than scoring five hundred.
 */
const MAX_CUSTOMERS = 2_000;
const MAX_TICKETS = 5_000;
const MAX_SENTIMENT_ROWS = 5_000;
const MAX_USAGE_ROWS = 5_000;

/** How far back a trend and a signal look. */
const HISTORY_DEPTH = 12;

export type HealthStatus = CustomerHealthBand;

/**
 * One customer's score, in the shape the customer-executive surface reads.
 *
 * `breakdown` is kept for that surface and `decomposition` is the honest field
 * beside it: the legacy five-number breakdown has no vocabulary for "we could
 * not measure this", and filling an unmeasured input with a zero would make
 * every tenant with no support desk look like they were failing one. Unmeasured
 * inputs are therefore filled with the composite — they neither drag the picture
 * down nor claim a strength — and `decomposition` carries what actually
 * happened, input by input, with the weight each was given.
 */
export interface HealthScoreResult {
  clientAccountId: number;
  clientName: string;
  score: number;
  status: HealthStatus;
  breakdown: HealthScoreBreakdown;
  /** Ticket 08's second criterion: every input, its weight, and whether it existed. */
  decomposition: readonly HealthContribution[];
  coverageBps: number;
  basis: HealthBasis;
  partyId: string;
}

export function getDefaultHealthConfig(): {
  weights: HealthScoreWeights;
  thresholds: HealthScoreThresholds;
} {
  return {
    weights: { sla: 25, csat: 25, activity: 20, renewal: 15, tickets: 15 },
    thresholds: { healthy: 70, atRisk: 40 },
  };
}

export interface LatestHealthScore {
  clientAccountId: number;
  clientName: string;
  score: number;
  status: HealthStatus;
  breakdown: HealthScoreBreakdown;
  computedAt: string;
  /** The same decomposition, so a detail view need not recompute anything. */
  decomposition: readonly HealthContribution[];
  coverageBps: number;
  basis: HealthBasis;
  /** `improving` · `steady` · `declining` · `unknown`. Criterion 4. */
  trend: string;
  trendDeltaPoints: number;
  partyId: string;
}

export interface HealthScoresSummary {
  healthy: number;
  atRisk: number;
  critical: number;
  total: number;
  avgScore: number;
  /**
   * Customers nothing could be measured about.
   *
   * Counted rather than scored. The service this replaces gave them a neutral
   * fifty and no way to tell them apart from a genuinely middling account, which
   * is exactly the number nobody can interrogate that the ticket is about.
   */
  unscored: number;
}

/** A customer, however they arrived — a legacy account, a lifecycle, or both. */
interface Customer {
  readonly partyId: string;
  readonly clientAccountId: number | null;
  readonly clientName: string;
  readonly customerLifecycleId: string | null;
  /** `YYYY-MM-DD`, from the lifecycle where there is one, the account otherwise. */
  readonly renewalDate: string | null;
}

@Injectable()
export class CsHealthService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Score every customer a tenant has, and append the results.
   *
   * Returns one entry per legacy client account, unchanged, because that is what
   * the customer-executive surface renders. Parties that have a lifecycle but no
   * account are scored and persisted too — they are customers — they simply have
   * no account id to be returned under, and the lifecycle surface is where they
   * are read.
   */
  async computeHealthForOrg(orgId: string, now: Date = new Date()): Promise<HealthScoreResult[]> {
    const [configRow, customers] = await Promise.all([
      this.db.query.healthScoreConfig.findFirst({ where: eq(healthScoreConfig.orgId, orgId) }),
      this.loadCustomers(orgId),
    ]);
    if (customers.length === 0) return [];

    const thresholds = configRow?.thresholds ?? getDefaultHealthConfig().thresholds;
    const weightsBps = healthWeightsFromConfig(configRow?.weights);

    const partyIds = customers.map((customer) => customer.partyId);
    const [engagement, tickets, sentiment, usage, previous] = await Promise.all([
      this.engagementFacts(orgId, partyIds, now),
      this.ticketFacts(orgId, partyIds, now),
      this.sentimentFacts(orgId, partyIds, now),
      this.usageFacts(orgId, partyIds, now),
      this.latestPoints(orgId, partyIds),
    ]);

    const results: HealthScoreResult[] = [];
    const rows: (typeof customerHealthScores.$inferInsert)[] = [];
    const signalWrites: {
      customerLifecycleId: string;
      partyId: string;
      point: HealthPoint;
      before: HealthPoint | null;
    }[] = [];

    for (const customer of customers) {
      const outcome = scoreHealth({
        now,
        weightsBps,
        thresholds,
        usage: { observations: usage.get(customer.partyId) ?? [] },
        engagement: engagement.get(customer.partyId) ?? {
          lastActivityAt: null,
          countInWindow: 0,
          countInPriorWindow: 0,
        },
        support: { tickets: tickets.get(customer.partyId) ?? [] },
        sentiment: sentiment.get(customer.partyId) ?? { positive: 0, neutral: 0, negative: 0 },
        renewal: {
          daysToRenewal: customer.renewalDate ? daysUntil(customer.renewalDate, now) : null,
        },
      });

      // Nothing was measurable. No row, no invented number — the customer is
      // counted as unscored by the summary and says so on the surface.
      if (!outcome.scored) continue;

      rows.push({
        organizationId: orgId,
        partyId: customer.partyId,
        customerLifecycleId: customer.customerLifecycleId,
        score: outcome.score,
        band: outcome.band,
        contributions: [...outcome.contributions],
        coverageBps: outcome.coverageBps,
        basis: outcome.basis,
        computedAt: now,
      });

      if (customer.customerLifecycleId)
        signalWrites.push({
          customerLifecycleId: customer.customerLifecycleId,
          partyId: customer.partyId,
          before: previous.get(customer.partyId) ?? null,
          point: {
            score: outcome.score,
            band: outcome.band,
            coverageBps: outcome.coverageBps,
            availableInputs: availableInputsOf(outcome.contributions),
            computedAt: now,
          },
        });

      if (customer.clientAccountId !== null)
        results.push({
          clientAccountId: customer.clientAccountId,
          clientName: customer.clientName,
          score: outcome.score,
          status: outcome.band,
          breakdown: toLegacyBreakdown(outcome.contributions, outcome.score),
          decomposition: outcome.contributions,
          coverageBps: outcome.coverageBps,
          basis: outcome.basis,
          partyId: customer.partyId,
        });
    }

    if (rows.length > 0) await this.db.insert(customerHealthScores).values(rows);

    /**
     * Criterion 5, and it happens after the scores are durable on purpose.
     *
     * A signal is a claim that health changed, and a signal written before the
     * score it refers to would survive a failed insert as a claim about a number
     * nobody can look up.
     */
    await this.appendHealthSignals(orgId, signalWrites);

    return results;
  }

  /**
   * The latest score per customer, with its decomposition and its trend.
   *
   * Reads the party-anchored history and maps it back onto accounts, so the
   * existing surface is unchanged while the storage underneath is the one the
   * lifecycle view reads too. There is exactly one health table.
   */
  async getLatestHealthScores(orgId: string): Promise<{
    items: LatestHealthScore[];
    summary: HealthScoresSummary;
  }> {
    const customers = await this.loadCustomers(orgId);
    const accounts = customers.filter((customer) => customer.clientAccountId !== null);
    if (accounts.length === 0)
      return {
        items: [],
        summary: { healthy: 0, atRisk: 0, critical: 0, total: 0, avgScore: 0, unscored: 0 },
      };

    const partyIds = [...new Set(accounts.map((customer) => customer.partyId))];
    const history = await this.historyFor(orgId, partyIds);

    const items: LatestHealthScore[] = [];
    let unscored = 0;

    for (const account of accounts) {
      const points = history.get(account.partyId) ?? [];
      const latest = points[0];
      if (!latest) {
        unscored += 1;
        continue;
      }

      const trend = healthTrend(points.map((entry) => entry.point));

      items.push({
        clientAccountId: account.clientAccountId!,
        clientName: account.clientName,
        score: latest.point.score,
        status: latest.point.band,
        breakdown: toLegacyBreakdown(latest.contributions, latest.point.score),
        decomposition: latest.contributions,
        coverageBps: latest.point.coverageBps,
        basis: latest.basis,
        computedAt: latest.point.computedAt.toISOString(),
        trend: trend.direction,
        trendDeltaPoints: trend.deltaPoints,
        partyId: account.partyId,
      });
    }

    items.sort((a, b) => a.score - b.score);
    const total = items.length;
    const healthy = items.filter((item) => item.status === "healthy").length;
    const atRisk = items.filter((item) => item.status === "at_risk").length;
    const critical = items.filter((item) => item.status === "critical").length;
    const avgScore =
      total > 0 ? Math.round(items.reduce((sum, item) => sum + item.score, 0) / total) : 0;

    return { items, summary: { healthy, atRisk, critical, total, avgScore, unscored } };
  }

  async getOrgHealthConfig(orgId: string): Promise<{
    weights: HealthScoreWeights;
    thresholds: HealthScoreThresholds;
    isDefault: boolean;
  }> {
    const row = await this.db.query.healthScoreConfig.findFirst({
      where: eq(healthScoreConfig.orgId, orgId),
    });
    if (!row) {
      const defaults = getDefaultHealthConfig();
      return { ...defaults, isDefault: true };
    }
    return { weights: row.weights, thresholds: row.thresholds, isDefault: false };
  }

  async upsertOrgHealthConfig(
    orgId: string,
    userId: string,
    weights: HealthScoreWeights,
    thresholds: HealthScoreThresholds,
  ): Promise<{ weights: HealthScoreWeights; thresholds: HealthScoreThresholds }> {
    const [row] = await this.db
      .insert(healthScoreConfig)
      .values({ orgId, weights, thresholds, updatedBy: userId })
      .onConflictDoUpdate({
        target: healthScoreConfig.orgId,
        set: { weights, thresholds, updatedBy: userId, updatedAt: new Date() },
      })
      .returning({
        weights: healthScoreConfig.weights,
        thresholds: healthScoreConfig.thresholds,
      });

    if (!row) throw new Error("health config upsert returned no row");
    return { weights: row.weights, thresholds: row.thresholds };
  }

  // ── Facts ─────────────────────────────────────────────────────────────────

  /**
   * Who this tenant's customers are, as parties.
   *
   * A legacy account reaches its party through `lead_party_id`, which migration
   * 0275 backfilled and 0276 keeps in step with a trigger. An account whose lead
   * has no party cannot be anchored and is skipped rather than scored under a
   * fabricated identity — the whole point of the anchor is that it identifies
   * somebody.
   *
   * Lifecycles are unioned in because a customer can have a contract without
   * ever having had one of these legacy account rows, and health that only
   * existed for accounts would leave every such customer invisible.
   */
  private async loadCustomers(orgId: string): Promise<Customer[]> {
    const [accounts, lifecycles] = await Promise.all([
      this.db
        .select({
          id: clientAccounts.id,
          clientName: clientAccounts.clientName,
          partyId: clientAccounts.leadPartyId,
          renewalDate: clientAccounts.renewalDate,
        })
        .from(clientAccounts)
        .where(and(eq(clientAccounts.orgId, orgId), isNotNull(clientAccounts.leadPartyId)))
        .orderBy(clientAccounts.id)
        .limit(MAX_CUSTOMERS),
      this.db
        .select({
          customerLifecycleId: customerLifecycles.customerLifecycleId,
          partyId: customerLifecycles.partyId,
          renewalDate: customerLifecycles.renewalDate,
        })
        .from(customerLifecycles)
        .where(eq(customerLifecycles.organizationId, orgId))
        .orderBy(customerLifecycles.renewalDate)
        .limit(MAX_CUSTOMERS),
    ]);

    const lifecycleOf = new Map(lifecycles.map((row) => [row.partyId, row]));
    const byParty = new Map<string, Customer>();

    for (const account of accounts) {
      const partyId = account.partyId;
      if (!partyId) continue;
      const lifecycle = lifecycleOf.get(partyId);
      byParty.set(partyId, {
        partyId,
        clientAccountId: account.id,
        clientName: account.clientName,
        customerLifecycleId: lifecycle?.customerLifecycleId ?? null,
        // The lifecycle's renewal date wins where there is one: it came from the
        // contract's own term, while the account's is a field somebody typed.
        renewalDate: lifecycle?.renewalDate ?? account.renewalDate ?? null,
      });
    }

    for (const lifecycle of lifecycles) {
      if (byParty.has(lifecycle.partyId)) continue;
      byParty.set(lifecycle.partyId, {
        partyId: lifecycle.partyId,
        clientAccountId: null,
        clientName: "Customer",
        customerLifecycleId: lifecycle.customerLifecycleId,
        renewalDate: lifecycle.renewalDate,
      });
    }

    return [...byParty.values()];
  }

  /**
   * Engagement, from the unified timeline and from nothing else.
   *
   * `activities` rather than `client_account_activities`, which is what the old
   * service read: the unified timeline is where mail, calls and meetings land
   * from every ingress, and the account-activity table sees only what somebody
   * typed into the accounts screen. One grouped read with two filtered counts,
   * because the momentum half needs the window before the window.
   */
  private async engagementFacts(
    orgId: string,
    partyIds: readonly string[],
    now: Date,
  ): Promise<Map<string, { lastActivityAt: Date | null; countInWindow: number; countInPriorWindow: number }>> {
    const out = new Map<
      string,
      { lastActivityAt: Date | null; countInWindow: number; countInPriorWindow: number }
    >();
    if (partyIds.length === 0) return out;

    const windowStart = new Date(now.getTime() - ENGAGEMENT_WINDOW_DAYS * DAY_MS);
    const priorStart = new Date(now.getTime() - 2 * ENGAGEMENT_WINDOW_DAYS * DAY_MS);

    const rows = await this.db
      .select({
        partyId: activities.partyId,
        lastActivityAt: sql<Date | null>`max(${activities.occurredAt})`,
        countInWindow: sql<number>`count(*) filter (where ${activities.occurredAt} >= ${windowStart})::int`,
        countInPriorWindow: sql<number>`count(*) filter (where ${activities.occurredAt} >= ${priorStart} and ${activities.occurredAt} < ${windowStart})::int`,
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, orgId),
          inArray(activities.partyId, [...partyIds]),
          isNull(activities.deletedAt),
        ),
      )
      .groupBy(activities.partyId);

    for (const row of rows) {
      if (!row.partyId) continue;
      out.set(row.partyId, {
        lastActivityAt: toDate(row.lastActivityAt),
        countInWindow: row.countInWindow,
        countInPriorWindow: row.countInPriorWindow,
      });
    }
    return out;
  }

  /** This customer's support history — theirs, not the organisation's. */
  private async ticketFacts(
    orgId: string,
    partyIds: readonly string[],
    now: Date,
  ): Promise<Map<string, SupportTicketFact[]>> {
    const out = new Map<string, SupportTicketFact[]>();
    if (partyIds.length === 0) return out;

    const rows = await this.db
      .select({
        partyId: supportTickets.clientPartyId,
        priority: supportTickets.priority,
        createdAt: supportTickets.createdAt,
        resolvedAt: supportTickets.resolvedAt,
        closedAt: supportTickets.closedAt,
        slaDeadline: supportTickets.slaDeadline,
      })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.orgId, orgId),
          inArray(supportTickets.clientPartyId, [...partyIds]),
          gte(supportTickets.createdAt, new Date(now.getTime() - SUPPORT_WINDOW_DAYS * DAY_MS)),
        ),
      )
      .limit(MAX_TICKETS);

    for (const row of rows) {
      if (!row.partyId) continue;
      const list = out.get(row.partyId) ?? [];
      list.push({
        priority: row.priority,
        openedAt: row.createdAt,
        // A closed ticket that was never marked resolved was still concluded.
        resolvedAt: row.resolvedAt ?? row.closedAt ?? null,
        slaDeadline: row.slaDeadline,
      });
      out.set(row.partyId, list);
    }
    return out;
  }

  /**
   * Sentiment, from conversation analysis, attributed to the right customer.
   *
   * Joined through the ticket to the party. The old service used
   * `csat_responses`, which carries no party at all — so one organisation-wide
   * average was written onto every account's breakdown, and a single unhappy
   * respondent moved every customer's score by the same amount. A number that
   * cannot be attributed is not evidence about anybody.
   */
  private async sentimentFacts(
    orgId: string,
    partyIds: readonly string[],
    now: Date,
  ): Promise<Map<string, { positive: number; neutral: number; negative: number }>> {
    const out = new Map<string, { positive: number; neutral: number; negative: number }>();
    if (partyIds.length === 0) return out;

    const rows = await this.db
      .select({
        partyId: supportTickets.clientPartyId,
        payload: supportAiSuggestions.payload,
      })
      .from(supportAiSuggestions)
      .innerJoin(supportTickets, eq(supportAiSuggestions.ticketId, supportTickets.id))
      .where(
        and(
          eq(supportAiSuggestions.orgId, orgId),
          eq(supportAiSuggestions.type, "sentiment"),
          inArray(supportTickets.clientPartyId, [...partyIds]),
          gte(
            supportAiSuggestions.createdAt,
            new Date(now.getTime() - SUPPORT_WINDOW_DAYS * DAY_MS),
          ),
        ),
      )
      .limit(MAX_SENTIMENT_ROWS);

    for (const row of rows) {
      if (!row.partyId) continue;
      const reading = row.payload["sentiment"];
      if (typeof reading !== "string") continue;

      const counts = out.get(row.partyId) ?? { positive: 0, neutral: 0, negative: 0 };
      if (reading === "positive") counts.positive += 1;
      else if (reading === "negative" || reading === "critical") counts.negative += 1;
      else if (reading === "neutral") counts.neutral += 1;
      else continue;
      out.set(row.partyId, counts);
    }
    return out;
  }

  /** Usage, where the tenant supplies it. The latest observation of each metric. */
  private async usageFacts(
    orgId: string,
    partyIds: readonly string[],
    now: Date,
  ): Promise<Map<string, UsageObservation[]>> {
    const out = new Map<string, UsageObservation[]>();
    if (partyIds.length === 0) return out;

    const rows = await this.db
      .select({
        partyId: customerUsageObservations.partyId,
        metricKey: customerUsageObservations.metricKey,
        observedValue: customerUsageObservations.observedValue,
        expectedValue: customerUsageObservations.expectedValue,
        observedAt: customerUsageObservations.observedAt,
      })
      .from(customerUsageObservations)
      .where(
        and(
          eq(customerUsageObservations.organizationId, orgId),
          inArray(customerUsageObservations.partyId, [...partyIds]),
          gte(
            customerUsageObservations.observedAt,
            new Date(now.getTime() - USAGE_FRESHNESS_DAYS * DAY_MS),
          ),
        ),
      )
      .orderBy(desc(customerUsageObservations.observedAt))
      .limit(MAX_USAGE_ROWS);

    // Newest first, so the first row seen for a metric is the latest one.
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.partyId} ${row.metricKey}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const list = out.get(row.partyId) ?? [];
      list.push({
        metricKey: row.metricKey,
        observedValue: row.observedValue,
        expectedValue: row.expectedValue,
        observedAt: row.observedAt,
      });
      out.set(row.partyId, list);
    }
    return out;
  }

  /** The score each party had before this run, for the change signal. */
  private async latestPoints(
    orgId: string,
    partyIds: readonly string[],
  ): Promise<Map<string, HealthPoint>> {
    const history = await this.historyFor(orgId, partyIds, 1);
    const out = new Map<string, HealthPoint>();
    for (const [partyId, entries] of history)
      if (entries[0]) out.set(partyId, entries[0].point);
    return out;
  }

  /** Recent scores per party, newest first — the read a trend is taken from. */
  private async historyFor(
    orgId: string,
    partyIds: readonly string[],
    depth: number = HISTORY_DEPTH,
  ): Promise<
    Map<string, { point: HealthPoint; contributions: HealthContribution[]; basis: HealthBasis }[]>
  > {
    const out = new Map<
      string,
      { point: HealthPoint; contributions: HealthContribution[]; basis: HealthBasis }[]
    >();
    if (partyIds.length === 0) return out;

    const rows = await this.db
      .select({
        partyId: customerHealthScores.partyId,
        score: customerHealthScores.score,
        band: customerHealthScores.band,
        coverageBps: customerHealthScores.coverageBps,
        basis: customerHealthScores.basis,
        contributions: customerHealthScores.contributions,
        computedAt: customerHealthScores.computedAt,
      })
      .from(customerHealthScores)
      .where(
        and(
          eq(customerHealthScores.organizationId, orgId),
          inArray(customerHealthScores.partyId, [...partyIds]),
        ),
      )
      .orderBy(desc(customerHealthScores.computedAt))
      .limit(partyIds.length * depth);

    for (const row of rows) {
      const entries = out.get(row.partyId) ?? [];
      if (entries.length >= depth) continue;
      entries.push({
        basis: row.basis,
        contributions: row.contributions,
        point: {
          score: row.score,
          band: row.band,
          coverageBps: row.coverageBps,
          availableInputs: availableInputsOf(row.contributions),
          computedAt: row.computedAt,
        },
      });
      out.set(row.partyId, entries);
    }
    return out;
  }

  /**
   * A score change worth telling somebody about, on the customer's own history.
   *
   * The same table the relationship loop's conclusions land in, so a health drop
   * and a champion going quiet arrive on one list. `healthSignals` returns
   * nothing far more often than not — that is the intended behaviour, not a
   * failure to notice anything.
   */
  private async appendHealthSignals(
    orgId: string,
    writes: readonly {
      customerLifecycleId: string;
      partyId: string;
      point: HealthPoint;
      before: HealthPoint | null;
    }[],
  ): Promise<void> {
    const rows = writes.flatMap((write) =>
      healthSignals(write.before, write.point).map((signal) => ({
        organizationId: orgId,
        customerLifecycleId: write.customerLifecycleId,
        partyId: write.partyId,
        kind: signal.kind,
        evidence: signal.evidence as Record<string, string | number | null>,
        reversibility: signal.reversibility,
        summary: signal.summary,
        observedAt: signal.observedAt,
      })),
    );

    if (rows.length === 0) return;
    await this.db.insert(customerLifecycleSignals).values(rows);
  }
}

/**
 * The five-number breakdown the existing surface renders.
 *
 * `sla` and `tickets` both come from the support input, which is what they were
 * two views of. An input with no data takes the composite rather than a zero:
 * this shape cannot say "not measured", and a zero in a bar chart is a claim
 * that the customer is failing at something nobody looked at. `decomposition` is
 * the field that can say it, and is what a surface should move to.
 */
function toLegacyBreakdown(
  contributions: readonly HealthContribution[],
  composite: number,
): HealthScoreBreakdown {
  const valueOf = (input: HealthInput): number => {
    const entry = contributions.find((candidate) => candidate.input === input);
    if (!entry || entry.scoreBps === null) return composite;
    return Math.round(entry.scoreBps / 100);
  };

  return {
    sla: valueOf("support"),
    tickets: valueOf("support"),
    csat: valueOf("sentiment"),
    activity: valueOf("engagement"),
    renewal: valueOf("renewal"),
  };
}

/** `max()` comes back as a string on some drivers and a Date on others. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
