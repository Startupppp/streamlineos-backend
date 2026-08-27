import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties, crmPipelineStages, deals, organizations } from "../../db/schema";
import {
  customerHealthScores,
  customerLifecycleSignals,
  customerLifecycles,
  type CustomerHealthBand,
  type CustomerLifecycleStage,
} from "../../db/schema/crm/customer-lifecycle";
import { fromMinorUnits } from "../deals/deal-stage-ledger";
import {
  availableInputsOf,
  healthTrend,
  type HealthPoint,
} from "./health-score";
import {
  lifecycleFromClosedWonDeal,
  lifecycleOpenedSignal,
  type ClosedWonDeal,
  type CustomerLifecycleSignal,
  type LifecycleRecord,
} from "./lifecycle-record";
import {
  CUSTOMER_LIFECYCLE_LAYOUT,
  type CustomerLifecycleRow,
  type LifecycleRecordLayout,
} from "./customer-lifecycle-record-type";

/**
 * The lifecycle records themselves: opening them, reading them, and their history.
 *
 * The service gathers facts and calls the rules; `lifecycle-record.ts` decides
 * what a won deal means and `health-score.ts` decides what a score means. Nothing
 * about a term, a renewal date or a trend is decided in this file.
 */

/**
 * The stage keys a won deal is in when a tenant has never configured a pipeline.
 *
 * The tenant's own `crm_pipeline_stages` with `stage_type = 'won'` is the
 * authority and is consulted first — a tenant who renamed "Won" to "Signed" must
 * not silently stop producing lifecycles. This list is what remains for the
 * tenants whose deals still carry the column's own default vocabulary.
 */
const FALLBACK_WON_STAGE_KEYS = ["WON", "CLOSED_WON", "CONVERTED"] as const;

/**
 * How many deals one sweep will look at.
 *
 * A bound rather than a page, because the sweep is idempotent: whatever it does
 * not reach this run it reaches the next one, and an unbounded scan over a
 * tenant with a decade of won deals is the kind of query that takes a database
 * down at three in the morning with nobody watching.
 */
const SWEEP_LIMIT = 500;

/** How far back a trend looks. Enough to see a slide, small enough to be one read. */
const HISTORY_DEPTH = 12;

interface LifecycleRow {
  readonly customerLifecycleId: string;
  readonly partyId: string;
  readonly stage: CustomerLifecycleStage;
  readonly termMonths: number;
  readonly termSource: string;
  readonly contractValueMinor: number;
  readonly currencyCode: string;
  readonly startedAt: Date;
  readonly renewalDate: string;
  readonly originDealId: string | null;
}

@Injectable()
export class CustomerLifecycleService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  layout(): LifecycleRecordLayout {
    return CUSTOMER_LIFECYCLE_LAYOUT;
  }

  /**
   * The tenant's own definition of a won stage, with a stated fallback.
   *
   * Read every sweep rather than cached: a tenant reconfiguring their pipeline
   * on Tuesday should not need a deploy for Wednesday's contracts to appear.
   */
  private async wonStageKeys(orgId: string): Promise<string[]> {
    const rows = await this.db
      .select({ key: crmPipelineStages.key })
      .from(crmPipelineStages)
      .where(
        and(
          eq(crmPipelineStages.orgId, orgId),
          eq(crmPipelineStages.stageType, "won"),
          eq(crmPipelineStages.isActive, true),
        ),
      );

    const keys = [...new Set(rows.map((row) => row.key))];
    return keys.length > 0 ? keys : [...FALLBACK_WON_STAGE_KEYS];
  }

  /**
   * Every closed-won deal that has no lifecycle yet, given one.
   *
   * A sweep rather than only an event handler, deliberately. A hook fired at the
   * moment a deal closes cannot produce a record for the deals that closed
   * before this shipped, and a tenant whose entire customer base predates the
   * feature would see an empty screen and conclude it does not work. It is
   * idempotent — the unique index on (organisation, party) is what makes it so
   * rather than the read that precedes it, because two sweeps can overlap.
   */
  async openFromClosedWonDeals(orgId: string, now: Date = new Date()): Promise<number> {
    const [org] = await this.db
      .select({ currency: organizations.currency })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) return 0;

    const wonKeys = await this.wonStageKeys(orgId);

    const candidates = await this.db
      .select({
        id: deals.id,
        partyId: deals.partyId,
        name: deals.name,
        valueMinor: deals.valueMinor,
        actualCloseDate: deals.actualCloseDate,
        updatedAt: deals.updatedAt,
        customData: deals.customData,
      })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, orgId),
          inArray(deals.stage, wonKeys),
          isNull(deals.deletedAt),
          isNotNull(deals.partyId),
        ),
      )
      .orderBy(desc(deals.updatedAt))
      .limit(SWEEP_LIMIT);

    let opened = 0;
    for (const candidate of candidates) {
      const partyId = candidate.partyId;
      if (!partyId) continue;

      const closedWon: ClosedWonDeal = {
        dealId: String(candidate.id),
        organizationId: orgId,
        partyId,
        valueMinor: candidate.valueMinor,
        currencyCode: org.currency,
        closedAt: closeInstant(candidate.actualCloseDate, candidate.updatedAt, now),
        termMonths: statedTermMonths(candidate.customData),
      };

      const record = lifecycleFromClosedWonDeal(closedWon);
      if (await this.insertLifecycle(record)) opened += 1;
    }

    return opened;
  }

  /**
   * One deal, for the caller that already knows a deal just closed.
   *
   * The seam the deals module would use if it wanted a lifecycle the instant a
   * stage moved rather than by the next sweep. Returns null when the deal is not
   * won, has no party, or already has a lifecycle — none of which is an error.
   */
  async openForDeal(orgId: string, dealId: number, now: Date = new Date()): Promise<LifecycleRecord | null> {
    const [org] = await this.db
      .select({ currency: organizations.currency })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) return null;

    const [deal] = await this.db
      .select({
        id: deals.id,
        stage: deals.stage,
        partyId: deals.partyId,
        valueMinor: deals.valueMinor,
        actualCloseDate: deals.actualCloseDate,
        updatedAt: deals.updatedAt,
        customData: deals.customData,
      })
      .from(deals)
      .where(and(eq(deals.orgId, orgId), eq(deals.id, dealId), isNull(deals.deletedAt)))
      .limit(1);

    if (!deal?.partyId) return null;

    const wonKeys = await this.wonStageKeys(orgId);
    if (!wonKeys.includes(deal.stage)) return null;

    const record = lifecycleFromClosedWonDeal({
      dealId: String(deal.id),
      organizationId: orgId,
      partyId: deal.partyId,
      valueMinor: deal.valueMinor,
      currencyCode: org.currency,
      closedAt: closeInstant(deal.actualCloseDate, deal.updatedAt, now),
      termMonths: statedTermMonths(deal.customData),
    });

    return (await this.insertLifecycle(record)) ? record : null;
  }

  /**
   * The write, and the signal that goes with it.
   *
   * `onConflictDoNothing` on the party index rather than a read-then-write:
   * two sweeps overlapping is a race a SELECT cannot close, and losing it would
   * raise a unique violation on a background job nobody is watching. Returns
   * false when the customer already had a lifecycle, which is the ordinary case.
   */
  private async insertLifecycle(record: LifecycleRecord): Promise<boolean> {
    const inserted = await this.db
      .insert(customerLifecycles)
      .values({
        organizationId: record.organizationId,
        partyId: record.partyId,
        originDealId: record.originDealId,
        stage: record.stage,
        termMonths: record.termMonths,
        termSource: record.termSource,
        contractValueMinor: record.contractValueMinor,
        currencyCode: record.currencyCode,
        startedAt: record.startedAt,
        renewalDate: record.renewalDate,
      })
      .onConflictDoNothing({
        target: [customerLifecycles.organizationId, customerLifecycles.partyId],
      })
      .returning({ customerLifecycleId: customerLifecycles.customerLifecycleId });

    const row = inserted[0];
    if (!row) return false;

    await this.recordSignals(record.organizationId, row.customerLifecycleId, record.partyId, [
      lifecycleOpenedSignal(record),
    ]);
    return true;
  }

  /**
   * Append signals to a customer's history.
   *
   * Append-only by construction: there is no update path to this table anywhere
   * in the module, which is what makes criterion 4 true rather than intended.
   */
  async recordSignals(
    orgId: string,
    customerLifecycleId: string,
    partyId: string,
    signals: readonly CustomerLifecycleSignal[],
  ): Promise<void> {
    if (signals.length === 0) return;

    await this.db.insert(customerLifecycleSignals).values(
      signals.map((signal) => ({
        organizationId: orgId,
        customerLifecycleId,
        partyId,
        kind: signal.kind,
        evidence: signal.evidence as Record<string, string | number | null>,
        reversibility: signal.reversibility,
        summary: signal.summary,
        observedAt: signal.observedAt,
      })),
    );
  }

  /** The lifecycle a party has, if any. Used by the health service and the sweep. */
  async findByParty(
    orgId: string,
    partyId: string,
  ): Promise<{ customerLifecycleId: string; stage: CustomerLifecycleStage } | null> {
    const [row] = await this.db
      .select({
        customerLifecycleId: customerLifecycles.customerLifecycleId,
        stage: customerLifecycles.stage,
      })
      .from(customerLifecycles)
      .where(
        and(eq(customerLifecycles.organizationId, orgId), eq(customerLifecycles.partyId, partyId)),
      )
      .limit(1);

    return row ?? null;
  }

  /** Rows keyed to the layout, for the renderer. */
  async list(orgId: string, limit: number): Promise<{ items: CustomerLifecycleRow[] }> {
    const rows = await this.db
      .select({
        customerLifecycleId: customerLifecycles.customerLifecycleId,
        partyId: customerLifecycles.partyId,
        stage: customerLifecycles.stage,
        termMonths: customerLifecycles.termMonths,
        termSource: customerLifecycles.termSource,
        contractValueMinor: customerLifecycles.contractValueMinor,
        currencyCode: customerLifecycles.currencyCode,
        startedAt: customerLifecycles.startedAt,
        renewalDate: customerLifecycles.renewalDate,
        originDealId: customerLifecycles.originDealId,
      })
      .from(customerLifecycles)
      .where(eq(customerLifecycles.organizationId, orgId))
      .orderBy(customerLifecycles.renewalDate)
      .limit(limit);

    return { items: await this.decorate(orgId, rows) };
  }

  async get(
    orgId: string,
    customerLifecycleId: string,
  ): Promise<{ record: CustomerLifecycleRow; signals: SignalRow[] }> {
    const [row] = await this.db
      .select({
        customerLifecycleId: customerLifecycles.customerLifecycleId,
        partyId: customerLifecycles.partyId,
        stage: customerLifecycles.stage,
        termMonths: customerLifecycles.termMonths,
        termSource: customerLifecycles.termSource,
        contractValueMinor: customerLifecycles.contractValueMinor,
        currencyCode: customerLifecycles.currencyCode,
        startedAt: customerLifecycles.startedAt,
        renewalDate: customerLifecycles.renewalDate,
        originDealId: customerLifecycles.originDealId,
      })
      .from(customerLifecycles)
      .where(
        and(
          eq(customerLifecycles.organizationId, orgId),
          eq(customerLifecycles.customerLifecycleId, customerLifecycleId),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Customer lifecycle not found");

    const [record] = await this.decorate(orgId, [row]);
    if (!record) throw new NotFoundException("Customer lifecycle not found");

    return { record, signals: await this.signals(orgId, customerLifecycleId, HISTORY_DEPTH * 4) };
  }

  /**
   * A customer's signal history, newest first.
   *
   * The accumulation criterion 4 asks for, read as a list rather than as a
   * current state — a customer who has been at risk twice and recovered twice is
   * a different account from one that has been at risk once, and only the list
   * can say so.
   */
  async signals(orgId: string, customerLifecycleId: string, limit: number): Promise<SignalRow[]> {
    const rows = await this.db
      .select({
        kind: customerLifecycleSignals.kind,
        evidence: customerLifecycleSignals.evidence,
        reversibility: customerLifecycleSignals.reversibility,
        summary: customerLifecycleSignals.summary,
        observedAt: customerLifecycleSignals.observedAt,
      })
      .from(customerLifecycleSignals)
      .where(
        and(
          eq(customerLifecycleSignals.organizationId, orgId),
          eq(customerLifecycleSignals.customerLifecycleId, customerLifecycleId),
        ),
      )
      .orderBy(desc(customerLifecycleSignals.observedAt))
      .limit(limit);

    return rows.map((row) => ({
      kind: row.kind,
      evidence: row.evidence,
      reversibility: row.reversibility,
      summary: row.summary,
      observedAt: row.observedAt.toISOString(),
    }));
  }

  /**
   * Attaches the name, the latest score and the trend to a page of lifecycles.
   *
   * Three bounded reads for the whole page rather than three per row: a health
   * trend needs history, and a per-row query for it is the shape that makes a
   * list of two hundred customers into six hundred round trips.
   */
  private async decorate(
    orgId: string,
    rows: readonly LifecycleRow[],
  ): Promise<CustomerLifecycleRow[]> {
    if (rows.length === 0) return [];

    const partyIds = [...new Set(rows.map((row) => row.partyId))];
    const lifecycleIds = rows.map((row) => row.customerLifecycleId);

    const [names, scores, signalCounts] = await Promise.all([
      this.db
        .select({ partyId: businessParties.partyId, name: businessParties.name })
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, orgId),
            inArray(businessParties.partyId, partyIds),
          ),
        ),
      this.db
        .select({
          partyId: customerHealthScores.partyId,
          score: customerHealthScores.score,
          band: customerHealthScores.band,
          coverageBps: customerHealthScores.coverageBps,
          contributions: customerHealthScores.contributions,
          computedAt: customerHealthScores.computedAt,
        })
        .from(customerHealthScores)
        .where(
          and(
            eq(customerHealthScores.organizationId, orgId),
            inArray(customerHealthScores.partyId, partyIds),
          ),
        )
        .orderBy(desc(customerHealthScores.computedAt))
        .limit(partyIds.length * HISTORY_DEPTH),
      this.db
        .select({
          customerLifecycleId: customerLifecycleSignals.customerLifecycleId,
          count: sql<number>`count(*)::int`,
        })
        .from(customerLifecycleSignals)
        .where(
          and(
            eq(customerLifecycleSignals.organizationId, orgId),
            inArray(customerLifecycleSignals.customerLifecycleId, lifecycleIds),
          ),
        )
        .groupBy(customerLifecycleSignals.customerLifecycleId),
    ]);

    const nameOf = new Map(names.map((row) => [row.partyId, row.name]));
    const countOf = new Map(signalCounts.map((row) => [row.customerLifecycleId, row.count]));

    const historyOf = new Map<string, HealthPoint[]>();
    for (const score of scores) {
      const points = historyOf.get(score.partyId) ?? [];
      points.push({
        score: score.score,
        band: score.band,
        coverageBps: score.coverageBps,
        availableInputs: availableInputsOf(score.contributions),
        computedAt: score.computedAt,
      });
      historyOf.set(score.partyId, points);
    }

    return rows.map((row) => {
      const history = historyOf.get(row.partyId) ?? [];
      const latest = history[0];
      const trend = healthTrend(history);

      return {
        customerLifecycleId: row.customerLifecycleId,
        customerName: nameOf.get(row.partyId) ?? "Unknown customer",
        stage: row.stage,
        healthScore: latest?.score ?? null,
        healthBand: (latest?.band as CustomerHealthBand | undefined) ?? null,
        healthTrend: trend.direction,
        // Percent rather than basis points on the way out: the number is read by
        // a person, and "84%" is the sentence "we could measure most of it".
        healthCoverage: latest ? `${Math.round(latest.coverageBps / 100)}%` : "—",
        renewalDate: row.renewalDate,
        termMonths: row.termMonths,
        termSource: row.termSource,
        contractValue: fromMinorUnits(row.contractValueMinor),
        currencyCode: row.currencyCode,
        startedAt: row.startedAt.toISOString(),
        originDealId: row.originDealId,
        partyId: row.partyId,
        signalCount: countOf.get(row.customerLifecycleId) ?? 0,
      };
    });
  }
}

export interface SignalRow {
  readonly kind: string;
  readonly evidence: Record<string, string | number | null>;
  readonly reversibility: string;
  readonly summary: string;
  readonly observedAt: string;
}

/**
 * When the contract actually started.
 *
 * `actual_close_date` where the pipeline recorded one, because that is the day
 * the customer believes they signed. `updated_at` is the fallback and is worse —
 * a deal edited months later moves it — but a term has to run from somewhere,
 * and a wrong renewal date somebody can see beats no lifecycle at all.
 */
function closeInstant(actualCloseDate: string | null, updatedAt: Date, now: Date): Date {
  if (actualCloseDate) {
    const parsed = Date.parse(`${actualCloseDate}T00:00:00Z`);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return updatedAt ?? now;
}

/**
 * A term the tenant recorded on the deal, if they recorded one at all.
 *
 * Read defensively because `custom_data` is a tenant-shaped blob: a string
 * "12" is as likely as a number, and anything else is not a term. Returning
 * null rather than guessing is what puts `termSource: "default"` on the record.
 */
function statedTermMonths(customData: Record<string, unknown> | null): number | null {
  const raw = customData?.["termMonths"];
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}
