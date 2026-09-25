import { BadRequestException } from "@nestjs/common";
import { cmpDec, divDec, mulDec } from "../stock-engine/decimal";

/**
 * NEO-10 - catch-weight, as the rules that decide whether a document line is
 * sayable at all.
 *
 * A catch-weight SKU is *sold* by weight and *handled* in pieces, and the two do
 * not derive from each other. Two bags of chicken are two bags and 10.35 kg, and
 * the second bag weighing 5.10 kg is not an error to be corrected - it is the
 * fact the invoice is raised on.
 *
 * The ledger holds the **weight**, because that is the number that has to add up
 * across receipts and issues; the piece count rides alongside on the document,
 * for the person counting the bags. Everything below is about keeping those two
 * consistent at the boundary, so nothing downstream has to wonder which it has.
 */

export type MeasureMode = "PIECES" | "CATCH_WEIGHT";

export interface CatchWeightLine {
  /** The ledger quantity. Weight for a catch-weight SKU, a count otherwise. */
  quantity: string;
  /** How many physical units. Required for catch-weight, forbidden otherwise. */
  quantityPieces: string | null;
}

/**
 * Refuse a line that does not say what its SKU requires.
 *
 * Both directions are refusals rather than repairs. A catch-weight line with no
 * piece count cannot be picked - nobody knows how many bags to take off the
 * shelf. A pieces line carrying a piece count *different* from its quantity is
 * two contradictory statements of the same fact, and guessing which one the
 * clerk meant is how a delivery gets counted wrong twice.
 */
export function assertCatchWeightLine(mode: MeasureMode, line: CatchWeightLine): void {
  if (mode === "CATCH_WEIGHT") {
    if (line.quantityPieces === null) {
      throw new BadRequestException(
        "This SKU is sold by weight and handled in pieces, so the line must state how many pieces as well as the weight",
      );
    }
    if (cmpDec(line.quantityPieces, "0") <= 0) {
      throw new BadRequestException("A catch-weight line must state at least one piece");
    }
    if (cmpDec(line.quantity, "0") <= 0) {
      throw new BadRequestException("A catch-weight line must state a weight");
    }
    return;
  }

  if (line.quantityPieces !== null && cmpDec(line.quantityPieces, line.quantity) !== 0) {
    throw new BadRequestException(
      "This SKU is counted in pieces, so its piece count and its quantity are the same number. Send one of them.",
    );
  }
}

/**
 * The average weight of a piece on this line, for a picker's sanity check.
 *
 * Reported, never enforced: bags genuinely differ, and a tolerance somebody
 * would have to configure is a setting that gets set once and then refuses real
 * deliveries for a year.
 */
export function averagePieceWeight(line: CatchWeightLine): string | null {
  if (line.quantityPieces === null || cmpDec(line.quantityPieces, "0") <= 0) return null;
  return divDec(line.quantity, line.quantityPieces);
}
