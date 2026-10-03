import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties } from "../../db/schema/party";
import { customerLifecycleSignals, customerLifecycles } from "../../db/schema/crm/lifecycle";
import { AT_RISK_THRESHOLD, WATCH_THRESHOLD, riskBand } from "./lifecycle-risk";
import { calendarDateOf, formatIsoDate } from "./lifecycle-terms";
import type {
  CloseLifecycleInput,
  ListLifecyclesQuery,
  RecordSignalInput,
  RenewLifecycleInput,
} from "./dto/lifecycle.schemas";
import type { ClosedWonDealRef, ClosedWonOutcome } from "./lifecycle.types";
import { openLifecycleFromClosedWon } from "./lib/lifecycle-open-term";
import { MS_PER_DAY } from "./lib/lifecycle-scoring";
import { closeLifecycle, recordLifecycleSignal, renewLifecycle } from "./lib/lifecycle-term-changes";

export type { ClosedWonDealRef, ClosedWonOutcome } from "./lifecycle.types";

/**
 * The renewal book: opening a term when a deal is won, and keeping it honest.
 *
 * Every query here carries the organisation predicate explicitly rather than
 * relying on RLS. RLS is the backstop; a missing `eq(organizationId, …)` in a
 * join that RLS happens to cover today is a cross-tenant read the day somebody
 * adds a service-role connection, and this table names what each customer pays.
 *
 * The service owns the writes but not the judgement: the term arithmetic lives
 * in `lifecycle-terms.ts` and the score in `lifecycle-risk.ts`, both pure, both
 * exercised at their boundaries. What is left here is traffic.
 */

@Injectable()
export class LifecycleService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // ── Opening a term ────────────────────────────────────────────────────────

  /**
   * Called from the deal's own stage transition, inside its transaction.
   *
   * `db` is a parameter rather than `this.db` for exactly that reason: a
   * lifecycle written outside the transaction that moved the deal can survive
   * that move being rolled back, which puts a contract in the renewal book for
   * a sale that never closed.
   *
   * It never throws for a business reason. Every refusal is a returned value —
   * see `lifecycle-origin.ts` — because an exception in here would roll back the
   * stage change and a rep would be unable to close a deal because the renewal
   * record could not be opened.
   */
  async recordClosedWon(
    db: Db,
    deal: ClosedWonDealRef,
    now: Date = new Date(),
  ): Promise<ClosedWonOutcome> {
    return openLifecycleFromClosedWon(db, deal, now);
  }

  // ── Reading the book ──────────────────────────────────────────────────────

  async list(organizationId: string, query: ListLifecyclesQuery) {
    const conditions: SQL[] = [eq(customerLifecycles.organizationId, organizationId)];

    if (query.status) conditions.push(eq(customerLifecycles.status, query.status));
    if (query.partyId) conditions.push(eq(customerLifecycles.partyId, query.partyId));

    if (query.renewingWithinDays !== undefined) {
      const cutoff = formatIsoDate(
        calendarDateOf(new Date(Date.now() + query.renewingWithinDays * MS_PER_DAY)),
      );
      conditions.push(lte(customerLifecycles.renewalOn, cutoff));
    }

    /**
     * The band is translated into the stored score rather than computed per row.
     * A band derived on read could not be filtered in the database, and a filter
     * applied after the page was cut returns short pages that look like the end
     * of the book.
     */
    if (query.band === "at-risk")
      conditions.push(gte(customerLifecycles.riskScore, AT_RISK_THRESHOLD));
    if (query.band === "watch") {
      conditions.push(gte(customerLifecycles.riskScore, WATCH_THRESHOLD));
      conditions.push(lte(customerLifecycles.riskScore, AT_RISK_THRESHOLD - 1));
    }
    if (query.band === "healthy")
      conditions.push(lte(customerLifecycles.riskScore, WATCH_THRESHOLD - 1));

    const rows = await this.db
      .select({
        customerLifecycleId: customerLifecycles.customerLifecycleId,
        partyId: customerLifecycles.partyId,
        partyName: businessParties.name,
        sourceDealId: customerLifecycles.sourceDealId,
        status: customerLifecycles.status,
        startedOn: customerLifecycles.startedOn,
        termMonths: customerLifecycles.termMonths,
        renewalOn: customerLifecycles.renewalOn,
        contractValueMinor: customerLifecycles.contractValueMinor,
        renewalCount: customerLifecycles.renewalCount,
        riskScore: customerLifecycles.riskScore,
        lastSignalAt: customerLifecycles.lastSignalAt,
      })
      .from(customerLifecycles)
      /**
       * Left, and tenant-matched on both columns. Left because a party that has
       * been soft-deleted or hard-removed must not make its contract disappear
       * from the book — money outlives a record. Tenant-matched because the
       * composite key is what stops a tampered `party_id` reaching another
       * organisation's name.
       */
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.partyId, customerLifecycles.partyId),
          eq(businessParties.organizationId, customerLifecycles.organizationId),
        ),
      )
      .where(and(...conditions))
      .orderBy(
        query.order === "risk"
          ? desc(customerLifecycles.riskScore)
          : asc(customerLifecycles.renewalOn),
        asc(customerLifecycles.customerLifecycleId),
      )
      .limit(query.limit + 1)
      .offset(query.offset);

    return {
      data: rows.slice(0, query.limit).map((row) => ({ ...row, band: riskBand(row.riskScore) })),
      hasMore: rows.length > query.limit,
    };
  }

  /** One contract with the evidence behind its score. Newest signal first. */
  async get(organizationId: string, customerLifecycleId: string) {
    const lifecycle = await this.load(organizationId, customerLifecycleId);

    const signals = await this.db
      .select({
        lifecycleSignalId: customerLifecycleSignals.lifecycleSignalId,
        kind: customerLifecycleSignals.kind,
        impact: customerLifecycleSignals.impact,
        observedAt: customerLifecycleSignals.observedAt,
        source: customerLifecycleSignals.source,
        recordedByUserId: customerLifecycleSignals.recordedByUserId,
        note: customerLifecycleSignals.note,
      })
      .from(customerLifecycleSignals)
      .where(
        and(
          eq(customerLifecycleSignals.organizationId, organizationId),
          eq(customerLifecycleSignals.customerLifecycleId, customerLifecycleId),
        ),
      )
      .orderBy(desc(customerLifecycleSignals.observedAt))
      .limit(200);

    return {
      data: { ...lifecycle, band: riskBand(lifecycle.riskScore), signals },
    };
  }

  // ── Keeping it honest ─────────────────────────────────────────────────────

  /**
   * Files evidence and re-scores the contract in one transaction.
   *
   * One transaction because the score is a materialisation of the signal set: a
   * signal that landed without its recomputation leaves a row whose number
   * disagrees with its own history, and the list this feature exists to produce
   * sorts on that number.
   */
  async recordSignal(
    organizationId: string,
    customerLifecycleId: string,
    input: RecordSignalInput,
    userId: string | null,
  ) {
    await this.load(organizationId, customerLifecycleId);
    return recordLifecycleSignal(this.db, organizationId, customerLifecycleId, input, userId);
  }

  /**
   * Advances the term in place and files the renewal as evidence.
   *
   * The new term starts where the old one ended by default, which is the only
   * value that leaves neither a gap nor an overlap in the book — a renewal dated
   * from today would silently shorten every contract by the days it took
   * somebody to record it.
   */
  async renew(
    organizationId: string,
    customerLifecycleId: string,
    input: RenewLifecycleInput,
    userId: string | null,
  ) {
    const lifecycle = await this.load(organizationId, customerLifecycleId);
    return renewLifecycle(this.db, lifecycle, organizationId, customerLifecycleId, input, userId);
  }

  /** Ends a contract. The reason is required — a book of endings without them measures nothing. */
  async close(
    organizationId: string,
    customerLifecycleId: string,
    input: CloseLifecycleInput,
  ) {
    await this.load(organizationId, customerLifecycleId);
    return closeLifecycle(this.db, organizationId, customerLifecycleId, input);
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  //
  // The score recomputation is `rescore` in `lib/lifecycle-scoring.ts`; the
  // writes it follows are in `lib/lifecycle-term-changes.ts`.

  private async load(organizationId: string, customerLifecycleId: string) {
    const [row] = await this.db
      .select()
      .from(customerLifecycles)
      .where(
        and(
          eq(customerLifecycles.organizationId, organizationId),
          eq(customerLifecycles.customerLifecycleId, customerLifecycleId),
        ),
      )
      .limit(1);

    /**
     * 404 rather than 403 for another tenant's identifier. A 403 would confirm
     * the contract exists, which is itself a disclosure about a competitor.
     */
    if (!row) throw new NotFoundException("Lifecycle not found");
    return row;
  }
}
