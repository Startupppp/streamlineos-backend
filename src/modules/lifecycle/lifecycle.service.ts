import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte, max, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties } from "../../db/schema/party";
import {
  customerLifecycleSignals,
  customerLifecycles,
  type CustomerLifecycleStatus,
} from "../../db/schema/crm/lifecycle";
import {
  isLegacyResolved,
  resolveLegacyParty,
  type LegacyPartyRef,
} from "../party/party-legacy-seam";
import {
  AT_RISK_THRESHOLD,
  WATCH_THRESHOLD,
  impactFor,
  riskBand,
  riskScore,
  SIGNAL_WINDOW_DAYS,
} from "./lifecycle-risk";
import { calendarDateOf, formatIsoDate, renewalDate } from "./lifecycle-terms";
import { lifecycleFromClosedWon, type ClosedWonDeal } from "./lifecycle-origin";
import type {
  CloseLifecycleInput,
  ListLifecyclesQuery,
  RecordSignalInput,
  RenewLifecycleInput,
} from "./dto/lifecycle.schemas";

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

/** The shape the deals module hands over. Its own type so the hook stays one call. */
export interface ClosedWonDealRef {
  readonly organizationId: string;
  readonly dealId: number;
  readonly partyId: string | null;
  readonly leadPartyId: string | null;
  readonly clientId: number | null;
  readonly leadId: number | null;
  readonly valueMinor: number;
  readonly actualCloseDate: string | null;
  readonly customData: unknown;
}

export type ClosedWonOutcome =
  | { readonly status: "opened"; readonly customerLifecycleId: string }
  /** A second closed-won transition on a deal that already has a term. */
  | { readonly status: "already-open" }
  | { readonly status: "skipped"; readonly reason: "no-party" | "unusable-term" };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
    const partyId = await this.resolveCustomerParty(db, deal);

    const origin = lifecycleFromClosedWon({
      organizationId: deal.organizationId,
      dealId: deal.dealId,
      partyId,
      valueMinor: deal.valueMinor,
      actualCloseDate: deal.actualCloseDate,
      customData: deal.customData,
      now,
    } satisfies ClosedWonDeal);

    if (!origin.ok) return { status: "skipped", reason: origin.reason };

    /**
     * `DO NOTHING` on the deal's unique index, not a read-then-write.
     *
     * A deal moved out of a won stage and back — a reversed approval, a
     * corrected misclick — reaches here twice, and two callers can reach here
     * concurrently through a bulk stage change. Checking first and inserting
     * second would let both checks miss and both inserts land, and the customer
     * would appear twice in the renewal book for one contract.
     */
    const inserted = await db
      .insert(customerLifecycles)
      .values({
        organizationId: origin.values.organizationId,
        partyId: origin.values.partyId,
        sourceDealId: origin.values.sourceDealId,
        startedOn: origin.values.startedOn,
        termMonths: origin.values.termMonths,
        renewalOn: origin.values.renewalOn,
        contractValueMinor: origin.values.contractValueMinor,
        riskComputedAt: now,
      })
      .onConflictDoNothing({
        target: [customerLifecycles.organizationId, customerLifecycles.sourceDealId],
      })
      .returning({ customerLifecycleId: customerLifecycles.customerLifecycleId });

    const row = inserted[0];
    return row
      ? { status: "opened", customerLifecycleId: row.customerLifecycleId }
      : { status: "already-open" };
  }

  /**
   * The customer behind a won deal, as a Party.
   *
   * `deals.party_id` first, because that is the column the CRM writes now. The
   * legacy identifiers are consulted only as a fallback and only through
   * `party-legacy-seam`, never by matching on a name or an email — a heuristic
   * join answers *a* customer, and answering the wrong one silently would put
   * one tenant's revenue against another customer's account.
   *
   * `deals.party_id` is resolved rather than trusted, so a party that has since
   * lost a merge anchors to the survivor. Anchoring to the consumed party would
   * hide the contract from the account it now belongs to.
   */
  private async resolveCustomerParty(db: Db, deal: ClosedWonDealRef): Promise<string | null> {
    const candidates: LegacyPartyRef[] = [];
    if (deal.partyId) candidates.push({ kind: "PARTY", legacyId: deal.partyId });
    if (deal.clientId !== null) candidates.push({ kind: "CLIENT", legacyId: deal.clientId });
    if (deal.leadPartyId) candidates.push({ kind: "PARTY", legacyId: deal.leadPartyId });
    if (deal.leadId !== null) candidates.push({ kind: "LEAD", legacyId: deal.leadId });

    for (const ref of candidates) {
      const resolution = await resolveLegacyParty(db, deal.organizationId, ref);
      if (isLegacyResolved(resolution)) return resolution.party.partyId;
    }

    return null;
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
      .limit(query.limit)
      .offset(query.offset);

    return {
      data: rows.map((row) => ({ ...row, band: riskBand(row.riskScore) })),
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

    return this.db.transaction(async (tx) => {
      const db = tx as Db;

      const [signal] = await db
        .insert(customerLifecycleSignals)
        .values({
          organizationId,
          customerLifecycleId,
          kind: input.kind,
          impact: impactFor(input.kind, input.impact),
          observedAt: input.observedAt ?? new Date(),
          source: userId ? "human" : "system",
          recordedByUserId: userId,
          note: input.note ?? null,
        })
        .returning();

      const rescored = await this.rescore(db, organizationId, customerLifecycleId);
      return { data: { signal, riskScore: rescored.riskScore, band: riskBand(rescored.riskScore) } };
    });
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

    if (lifecycle.status !== "active") {
      throw new NotFoundException("Only an active contract can be renewed");
    }

    const startedOn = input.startedOn ?? lifecycle.renewalOn;
    const termMonths = input.termMonths ?? lifecycle.termMonths;
    const nextRenewal = renewalDate(startedOn, termMonths);

    /**
     * Both halves are already bounded by the schema, so this is unreachable in
     * practice. It is a 404 rather than a 500 because the alternative is writing
     * `null` into a NOT NULL column and losing the contract's renewal date.
     */
    if (!nextRenewal) throw new NotFoundException("Unusable renewal term");

    return this.db.transaction(async (tx) => {
      const db = tx as Db;

      const [updated] = await db
        .update(customerLifecycles)
        .set({
          startedOn,
          termMonths,
          renewalOn: nextRenewal,
          contractValueMinor: input.contractValueMinor ?? lifecycle.contractValueMinor,
          renewalCount: lifecycle.renewalCount + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(customerLifecycles.organizationId, organizationId),
            eq(customerLifecycles.customerLifecycleId, customerLifecycleId),
            /**
             * The status is re-asserted in the WHERE rather than trusted from
             * the read above. Two people confirming the same renewal at once
             * would otherwise both advance the term and the contract would jump
             * two years forward for one signature.
             */
            eq(customerLifecycles.status, "active"),
            eq(customerLifecycles.renewalCount, lifecycle.renewalCount),
          ),
        )
        .returning();

      if (!updated) throw new NotFoundException("Contract changed while renewing");

      await db.insert(customerLifecycleSignals).values({
        organizationId,
        customerLifecycleId,
        kind: "renewal-commitment",
        impact: impactFor("renewal-commitment", null),
        observedAt: new Date(),
        source: userId ? "human" : "system",
        recordedByUserId: userId,
        note: input.note ?? null,
      });

      const rescored = await this.rescore(db, organizationId, customerLifecycleId);
      return { data: { ...updated, riskScore: rescored.riskScore, band: riskBand(rescored.riskScore) } };
    });
  }

  /** Ends a contract. The reason is required — a book of endings without them measures nothing. */
  async close(
    organizationId: string,
    customerLifecycleId: string,
    input: CloseLifecycleInput,
  ) {
    await this.load(organizationId, customerLifecycleId);

    const [updated] = await this.db
      .update(customerLifecycles)
      .set({
        status: input.status as CustomerLifecycleStatus,
        closedReason: input.reason,
        closedAt: new Date(),
        /**
         * Zeroed on close. The score answers "is this revenue at risk", and
         * revenue that has already gone is not at risk — leaving the last live
         * score behind would keep churned customers permanently at the top of
         * the triage list.
         */
        riskScore: 0,
        riskComputedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerLifecycles.organizationId, organizationId),
          eq(customerLifecycles.customerLifecycleId, customerLifecycleId),
          eq(customerLifecycles.status, "active"),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundException("Only an active contract can be closed");

    return { data: updated };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

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

  /**
   * Recomputes the score from the signals still inside the decay window.
   *
   * The window is applied in the query, not in the reducer: a customer with
   * three years of evidence would otherwise load three years of rows to
   * multiply almost all of them by zero.
   */
  private async rescore(db: Db, organizationId: string, customerLifecycleId: string) {
    const [lifecycle] = await db
      .select({
        renewalOn: customerLifecycles.renewalOn,
        status: customerLifecycles.status,
      })
      .from(customerLifecycles)
      .where(
        and(
          eq(customerLifecycles.organizationId, organizationId),
          eq(customerLifecycles.customerLifecycleId, customerLifecycleId),
        ),
      )
      .limit(1);

    if (!lifecycle) throw new NotFoundException("Lifecycle not found");

    const now = new Date();
    const since = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * MS_PER_DAY);

    const signals = await db
      .select({
        impact: customerLifecycleSignals.impact,
        observedAt: customerLifecycleSignals.observedAt,
      })
      .from(customerLifecycleSignals)
      .where(
        and(
          eq(customerLifecycleSignals.organizationId, organizationId),
          eq(customerLifecycleSignals.customerLifecycleId, customerLifecycleId),
          gte(customerLifecycleSignals.observedAt, since),
        ),
      );

    const score = riskScore({
      signals,
      renewalOn: lifecycle.renewalOn,
      status: lifecycle.status,
      asOf: now,
    });

    /**
     * Over every signal, not only the windowed ones. `last_signal_at` says how
     * fresh the evidence is; deriving it from the decay window would report a
     * contract whose last signal was four months ago as having none at all,
     * which reads as "nothing has happened" rather than "nothing recently".
     */
    const [newest] = await db
      .select({ observedAt: max(customerLifecycleSignals.observedAt) })
      .from(customerLifecycleSignals)
      .where(
        and(
          eq(customerLifecycleSignals.organizationId, organizationId),
          eq(customerLifecycleSignals.customerLifecycleId, customerLifecycleId),
        ),
      );
    const lastSignalAt = newest?.observedAt ?? null;

    await db
      .update(customerLifecycles)
      .set({ riskScore: score, riskComputedAt: now, lastSignalAt, updatedAt: now })
      .where(
        and(
          eq(customerLifecycles.organizationId, organizationId),
          eq(customerLifecycles.customerLifecycleId, customerLifecycleId),
        ),
      );

    return { riskScore: score };
  }
}
