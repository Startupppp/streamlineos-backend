import { ConflictException } from "@nestjs/common";
import { fromPaise, toPaise } from "../../runs/lib/money";

/** The two money columns of one `payroll_journal_batch_lines` row. */
export interface JournalLineAmounts {
  debit: string;
  credit: string;
}

/** The header a reversal will be written with. Rupee `numeric(15,2)` strings. */
export interface ReversalTotals {
  totalDebits: string;
  totalCredits: string;
}

/**
 * Derives a reversal's header from the contra lines it will actually carry, and
 * refuses one that would not reproduce the batch it claims to reverse.
 *
 * `reverseBatch` inserts the contra batch at status POSTED, so `markPosted`'s
 * balance check never runs on it. Its header used to be the ORIGINAL's totals
 * with the sides swapped — which stays "balanced" no matter how many of the
 * original's lines the read returned, so a short read wrote a reversal that did
 * not reverse the batch and nothing downstream could tell. Deriving the header
 * from the lines makes the two agree by construction; comparing it back to the
 * original's header is what catches a line set that is incomplete.
 *
 * MONEY: debit/credit are `numeric(15,2)` rupee strings. Everything is summed
 * as integer paise so the comparison is exact and no float holds a running
 * total; the result is converted back to the rupee wire format once.
 */
export function reversalTotalsFor(
  batchId: number,
  header: { totalDebits: string; totalCredits: string },
  originalLines: readonly JournalLineAmounts[],
): ReversalTotals {
  let debitsPaise = 0;
  let creditsPaise = 0;
  for (const line of originalLines) {
    // A reversal swaps the sides: the original's credit is the reversal's debit.
    debitsPaise += toPaise(line.credit);
    creditsPaise += toPaise(line.debit);
  }

  if (
    debitsPaise !== toPaise(header.totalCredits) ||
    creditsPaise !== toPaise(header.totalDebits)
  ) {
    throw new ConflictException(
      `Reversal of batch #${batchId} would not reproduce it: its ${originalLines.length} lines ` +
        `total ${fromPaise(debitsPaise)} debits / ${fromPaise(creditsPaise)} credits ` +
        `against a header of ${header.totalCredits} / ${header.totalDebits}.`,
    );
  }

  return { totalDebits: fromPaise(debitsPaise), totalCredits: fromPaise(creditsPaise) };
}
