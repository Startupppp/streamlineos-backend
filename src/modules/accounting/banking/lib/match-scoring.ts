/**
 * The suggestion engine's scoring, and the text rules it reads.
 *
 * Pure: no database and no model. Every point a candidate earns arrives with
 * the sentence that explains it, because a human has to accept the suggestion.
 */
import { assertIsoDate } from "../../kernel/fiscal-calendar";
import { money, toDecimalString } from "../../kernel/money";
import type { MatchSuggestion, StatementLineContext } from "../matching.types";

/**
 * Deterministic, explainable, and entirely local: 50 for the amount agreeing
 * at all, 20 for how close the dates are, 20 for the reference, 10 for words
 * in common. No model is consulted and none ever will be — a reconciliation a
 * human cannot audit is not a reconciliation.
 */
export function scoreCandidate(
  line: StatementLineContext,
  candidate: MatchSuggestion,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 50;
  reasons.push(
    `Amount matches exactly (${toDecimalString(money(candidate.amountMinor, candidate.currency))} ${candidate.currency})`,
  );

  const dayGap = Math.abs(daysBetween(line.valueDate, candidate.date));
  const dateScore = dayGap === 0 ? 20 : dayGap === 1 ? 15 : dayGap === 2 ? 10 : dayGap === 3 ? 5 : 0;
  score += dateScore;
  reasons.push(
    dayGap === 0 ? "Same date as the bank line" : `${dayGap} day${dayGap === 1 ? "" : "s"} from the bank line`,
  );

  const lineReference = normalizeReference(line.bankReference);
  const candidateReference = normalizeReference(candidate.reference);
  if (lineReference && candidateReference) {
    if (lineReference === candidateReference) {
      score += 20;
      reasons.push(`Reference matches exactly (${candidate.reference})`);
    } else if (
      lineReference.includes(candidateReference) ||
      candidateReference.includes(lineReference)
    ) {
      score += 12;
      reasons.push(`Reference overlaps (${candidate.reference})`);
    }
  }

  const overlap = diceCoefficient(
    tokenize(line.description ?? line.bankReference ?? ""),
    tokenize(candidate.searchText ?? candidate.label),
  );
  if (overlap > 0) {
    const descriptionScore = Math.round(10 * overlap);
    score += descriptionScore;
    if (descriptionScore > 0) reasons.push(`Description overlaps the counterpart (${Math.round(overlap * 100)}%)`);
  }

  return { score: Math.min(100, score), reasons };
}

/* ------------------------------------------------------------- text rules */

function normalizeReference(value: string | null): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length >= 3),
  );
}

/** Sørensen–Dice over token sets: 2|A∩B| / (|A|+|B|). */
function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return (2 * intersection) / (a.size + b.size);
}

function daysBetween(a: string, b: string): number {
  const left = Date.UTC(...isoParts(a));
  const right = Date.UTC(...isoParts(b));
  return Math.round((right - left) / 86_400_000);
}

function isoParts(value: string): [number, number, number] {
  const [y, m, d] = assertIsoDate(value).split("-").map(Number);
  return [y, m - 1, d];
}
