import { BadRequestException, NotFoundException } from "@nestjs/common";
import { addDec, cmpDec, isPositive, subDec } from "../../stock-engine/decimal";
import { INV_ERRORS } from "../../stock-engine/stock-engine.types";
import type {
  TransitExitDisposition,
  TransitExitInput,
} from "../dto/transit-exit.schemas";

/**
 * R3, item 2 — how much may leave transit, decided from the document *and* the
 * ledger, and the shape of the answer.
 *
 * Everything here is a pure function of values already read: no `db`, no `tx`,
 * no service. It sat as a block of module-level functions BELOW
 * `TransitExitService`, which is where the seam already was — `exitTransitInTx`
 * reaches for `buildGrainBudgets` and `resolveExitLines` the way it reaches for
 * `loadTransfer` in `lib/transit-document.ts`, and its unit test has been called
 * `transit-exit-lines.spec.ts` since it was written. The bound these compute is
 * the one thing standing between a caller's arithmetic and another transfer's
 * goods on the same transit bin, so it is worth being able to read it without
 * the command around it.
 */

/** One line's share of the exit, after the request has been reconciled with the document. */
interface ResolvedExitLine {
  transferLineId: number;
  productVariantId: number;
  lotId: number | null;
  serialId: number | null;
  quantity: string;
}

export interface TransitExitResult {
  transferId: number;
  disposition: TransitExitDisposition;
  /** Where the goods were standing, so a caller can go and look at what is left. */
  transitLocationId: number;
  lines: Array<{ transferLineId: number; quantity: string }>;
  transactionIds: number[];
  /** The transfer's status after the exit — terminal once nothing is left in transit. */
  transferStatus: string;
  strandedRemaining: string;
}

/** What one exit is taking in total, derived rather than re-summed. */
export function totalTaken(taken: ReadonlyArray<ResolvedExitLine>, remaining: string): string {
  return taken.reduce((sum, line) => addDec(sum, line.quantity), remaining);
}

/** The stock grain a transit balance is actually carried at. Lines are how a document spells it. */
export interface ExitGrain {
  productVariantId: number;
  lotId: number | null;
  serialId: number | null;
}

/** A document line, with what it dispatched and never received. */
export interface StrandedDocumentLine extends ExitGrain {
  transferLineId: number;
  stranded: string;
}

function grainKey(grain: ExitGrain): string {
  return `${grain.productVariantId}:${grain.lotId ?? ""}:${grain.serialId ?? ""}`;
}

/**
 * How much of this transfer is still standing in transit, per stock grain.
 *
 * Per grain rather than per line, and that is the correction that makes the
 * bound real. `quantity - quantity_received` is a property of the document and
 * no exit changes it, so a line-only bound recomputes the same remainder for
 * every command — a second exit under a fresh idempotency key would post the
 * whole shortfall a second time. Two lines of one transfer naming the same
 * (variant, lot, serial) had the same problem in miniature: each was bounded
 * separately against stock they share.
 *
 * What is physically there is `dispatched - received - already exited`, at the
 * grain the stock level is keyed on, and the exits are in the ledger.
 */
export function buildGrainBudgets(
  documentLines: ReadonlyArray<StrandedDocumentLine>,
  alreadyExited: ReadonlyArray<ExitGrain & { quantity: string }>,
): Map<string, string> {
  const budgets = new Map<string, string>();
  for (const line of documentLines) {
    if (!isPositive(line.stranded)) continue;
    const key = grainKey(line);
    budgets.set(key, addDec(budgets.get(key) ?? "0.0000", line.stranded));
  }
  for (const row of alreadyExited) {
    const key = grainKey(row);
    const current = budgets.get(key);
    if (current === undefined) continue;
    budgets.set(key, subDec(current, row.quantity));
  }
  return budgets;
}

/** What is left standing once this exit has taken its share. */
export function remainingStranded(budgets: ReadonlyMap<string, string>): string {
  let total = "0.0000";
  for (const left of budgets.values()) if (isPositive(left)) total = addDec(total, left);
  return total;
}

/**
 * Reconciles what the caller asked to exit with what is actually still there.
 *
 * Two bounds, both server-side. The line's own shortfall, so a caller cannot
 * take line B's units under line A's id; and the grain budget, which is what is
 * physically left. The second is the one that matters: a transit location is per
 * **warehouse**, so every dispatch out of it parks goods on the same bin, and a
 * caller who over-states does not get an error about their own transfer — the
 * engine finds the stock, because it is somebody else's, and moves it. The theft
 * looks like arithmetic.
 *
 * `budgets` is consumed as it goes, so repeated grains inside one request are
 * bounded together rather than each against the full remainder.
 */
export function resolveExitLines(
  documentLines: ReadonlyArray<StrandedDocumentLine>,
  requested: TransitExitInput["lines"],
  budgets: Map<string, string>,
): ResolvedExitLine[] {
  const byId = new Map(documentLines.map((line) => [line.transferLineId, line]));

  const take = (line: StrandedDocumentLine, quantity: string): ResolvedExitLine => {
    budgets.set(grainKey(line), subDec(budgets.get(grainKey(line)) ?? "0.0000", quantity));
    return {
      transferLineId: line.transferLineId,
      productVariantId: line.productVariantId,
      lotId: line.lotId,
      serialId: line.serialId,
      quantity,
    };
  };

  if (requested === undefined) {
    const resolved: ResolvedExitLine[] = [];
    for (const line of documentLines) {
      if (!isPositive(line.stranded)) continue;
      const budget = budgets.get(grainKey(line)) ?? "0.0000";
      if (!isPositive(budget)) continue;
      // Whichever bound bites first. A grain already partly exited leaves less
      // than the line's own shortfall.
      const quantity = cmpDec(line.stranded, budget) > 0 ? budget : line.stranded;
      resolved.push(take(line, quantity));
    }
    return resolved;
  }

  const seen = new Set<number>();
  const resolved: ResolvedExitLine[] = [];
  for (const ask of requested) {
    const line = byId.get(ask.transferLineId);
    if (!line)
      throw new NotFoundException(
        `Transfer line ${ask.transferLineId} does not belong to this transfer`,
      );
    if (seen.has(ask.transferLineId))
      throw new BadRequestException(
        `Transfer line ${ask.transferLineId} is named twice in one exit`,
      );
    seen.add(ask.transferLineId);

    const budget = budgets.get(grainKey(line)) ?? "0.0000";
    if (!isPositive(line.stranded) || !isPositive(budget))
      throw new BadRequestException(
        `Transfer line ${ask.transferLineId} has nothing standing in transit`,
      );

    const bound = cmpDec(line.stranded, budget) > 0 ? budget : line.stranded;
    const quantity = ask.quantity ?? bound;
    if (cmpDec(quantity, bound) > 0)
      throw new BadRequestException({
        code: INV_ERRORS.INSUFFICIENT_STOCK,
        message: `Transfer line ${ask.transferLineId} has only ${bound} in transit, not ${quantity}`,
      });

    resolved.push(take(line, quantity));
  }
  return resolved;
}

function asRecord(stored: unknown): Record<string, unknown> {
  return typeof stored === "object" && stored !== null
    ? (stored as Record<string, unknown>)
    : {};
}

/**
 * A replayed exit, rebuilt from the stored JSON rather than cast to it.
 *
 * The response has been through `jsonb`, so nothing about its runtime shape is
 * guaranteed by the type it was stored as.
 */
export function reviveTransitExit(stored: unknown): TransitExitResult {
  const row = asRecord(stored);
  const lines = Array.isArray(row.lines) ? row.lines : [];
  const transactionIds = Array.isArray(row.transactionIds) ? row.transactionIds : [];
  return {
    transferId: Number(row.transferId ?? 0),
    disposition: row.disposition === "WRITE_OFF" ? "WRITE_OFF" : "RETURN_TO_SOURCE",
    transitLocationId: Number(row.transitLocationId ?? 0),
    lines: lines.map((line) => {
      const l = asRecord(line);
      return {
        transferLineId: Number(l.transferLineId ?? 0),
        quantity: String(l.quantity ?? "0"),
      };
    }),
    transactionIds: transactionIds.map((id) => Number(id)),
    transferStatus: String(row.transferStatus ?? ""),
    strandedRemaining: String(row.strandedRemaining ?? "0"),
  };
}
