import {
  assessDuplicate,
  AUTO_MERGE_THRESHOLD,
  normaliseEmail,
  normaliseHost,
  normalisePhone,
  normaliseTaxNumber,
  REVIEW_THRESHOLD,
  type PartyFingerprint,
} from "../../party/party-duplicates";
import type { MappedColumn } from "./column-mapping";
import { readRow } from "./import-row-reader";
import type { Draft } from "./import-draft";

/**
 * The half of the planner that is specifically about parties.
 *
 * A party has no unique business key, so "is this the same company" is a
 * weighted judgement over several weak identifiers rather than a lookup — which
 * is why it needs blocking, thresholds and a band of doubt that the key-matched
 * entities do not have. Kept together here so the generic passes in
 * `import-plan.ts` read as generic, rather than as the party case with three
 * conditionals threaded through it.
 */

/**
 * The identifiers a file could possibly match an existing party on.
 *
 * Used to fetch candidates instead of reading an arbitrary slice of the tenant:
 * "the first ten thousand parties Postgres happened to return" is not a stable
 * set, so the same file previewed twice could plan a row as `update` once and
 * `create` the next time, and quietly grow a second copy of a customer.
 *
 * These four keys are enough, and that is a property of the weights in
 * `party-duplicates`, not a hope. Without a shared tax number, e-mail address,
 * phone number or website host, the most a pair can score is a matching e-mail
 * DOMAIN (0.12) plus an exactly equal name (0.3) — 0.42, below the 0.45 review
 * threshold and far below the 0.85 at which a row becomes an update. So a party
 * sharing none of these four cannot change any row's action, and not fetching it
 * costs nothing. `import-plan.spec` pins that arithmetic, because raising a name
 * weight past it would make this blocking unsound silently.
 */
export interface BlockingKeys {
  readonly taxNumbers: readonly string[];
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly hosts: readonly string[];
}

export function blockingKeysFor(
  columns: readonly MappedColumn[],
  rows: readonly (readonly string[])[],
): BlockingKeys {
  const taxNumbers = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  const hosts = new Set<string>();

  const add = (into: Set<string>, key: string): void => {
    if (key) into.add(key);
  };

  for (const cells of rows) {
    // Read through the same mapping the plan uses, so the keys come from the
    // columns the user confirmed rather than from wherever the file put them.
    const { values } = readRow("party", columns, cells);
    add(taxNumbers, normaliseTaxNumber(values.taxNumber));
    add(emails, normaliseEmail(values.email));
    add(phones, normalisePhone(values.phone));
    add(hosts, normaliseHost(values.website));
  }

  return {
    taxNumbers: [...taxNumbers],
    emails: [...emails],
    phones: [...phones],
    hosts: [...hosts],
  };
}

/**
 * The same four identifiers as one list, prefixed by kind.
 *
 * Prefixed because a tax number and a phone number can be the same digits, and
 * an index that let them collide would compare pairs that share nothing —
 * harmless for correctness, but it re-introduces the cost this exists to remove.
 */
function blockingKeysOf(fingerprint: PartyFingerprint): string[] {
  return [
    `t:${normaliseTaxNumber(fingerprint.taxNumber)}`,
    `e:${normaliseEmail(fingerprint.email)}`,
    `p:${normalisePhone(fingerprint.phone)}`,
    `h:${normaliseHost(fingerprint.website)}`,
  ].filter((key) => key.length > 2);
}

/**
 * Which records are worth comparing against which, by shared identifier.
 *
 * Comparing every row against every row is quadratic, and at the file sizes this
 * ticket is about that is the preview's own ceiling — five thousand rows is
 * twelve million scorings before anything is written. The soundness argument is
 * exactly the one `blockingKeysFor` makes for the database side, only stricter:
 * a pair sharing none of the four identifiers tops out at 0.42, and the bar for
 * folding two rows together is 0.85.
 */
export class BlockingIndex {
  private readonly byKey = new Map<string, number[]>();

  add(position: number, fingerprint: PartyFingerprint): void {
    for (const key of blockingKeysOf(fingerprint)) {
      const positions = this.byKey.get(key);
      if (!positions) this.byKey.set(key, [position]);
      else if (positions.at(-1) !== position) positions.push(position);
    }
  }

  /**
   * Ascending, and deduplicated.
   *
   * Order is not cosmetic: the caller takes the FIRST match, so this decides
   * which row a repeat is folded into. Ascending means the earliest occurrence
   * in the file wins, which is what a person reading their spreadsheet expects.
   */
  candidates(fingerprint: PartyFingerprint): number[] {
    const found = new Set<number>();
    for (const key of blockingKeysOf(fingerprint))
      for (const position of this.byKey.get(key) ?? []) found.add(position);
    return [...found].sort((left, right) => left - right);
  }
}

export function fingerprintOf(rowNumber: number, values: Record<string, string>): PartyFingerprint {
  return {
    partyId: `row:${rowNumber}`,
    name: values.name ?? "",
    legalName: values.legalName ?? null,
    email: values.email ?? null,
    phone: values.phone ?? null,
    taxNumber: values.taxNumber ?? null,
    website: values.website ?? null,
  };
}

/**
 * The earlier row of this file that this one repeats, by the duplicate scorer.
 *
 * The bar is `AUTO_MERGE_THRESHOLD` — the same 0.85 the commit uses against
 * existing parties — because folding two lines of one file into one record and
 * folding a line into an existing record are the same claim about identity.
 */
export function repeatByFingerprint(
  survivors: { draft: Draft; fingerprint: PartyFingerprint }[],
  withinFile: BlockingIndex,
  values: Record<string, string>,
): Draft | null {
  const fingerprint = fingerprintOf(0, values);
  const position = withinFile
    .candidates(fingerprint)
    .find(
      (candidate) =>
        assessDuplicate(survivors[candidate].fingerprint, fingerprint).score >=
        AUTO_MERGE_THRESHOLD,
    );

  return position === undefined ? null : survivors[position].draft;
}

/** The party pass: every surviving row against the candidates fetched for it. */
export function matchByFingerprint(
  survivors: { draft: Draft; fingerprint: PartyFingerprint }[],
  existing: readonly PartyFingerprint[],
): void {
  const existingIndex = new BlockingIndex();
  existing.forEach((party, position) => existingIndex.add(position, party));

  for (const survivor of survivors) {
    let best: { partyId: string; name: string; score: number; signals: readonly string[] } | null =
      null;

    for (const position of existingIndex.candidates(survivor.fingerprint)) {
      const candidate = existing[position];
      const { score, blockers, signals } = assessDuplicate(candidate, survivor.fingerprint);
      // A contradiction — two different tax numbers — is proof these are
      // different companies, however similar the names look.
      if (blockers.length > 0) continue;
      if (!best || score > best.score)
        best = { partyId: candidate.partyId, name: candidate.name, score, signals };
    }

    if (!best || best.score < REVIEW_THRESHOLD) continue;

    if (best.score >= AUTO_MERGE_THRESHOLD) {
      survivor.draft.action = "update";
      survivor.draft.reason = "Matches a party you already have; its details will be filled in.";
      survivor.draft.matchedRecordId = best.partyId;
      survivor.draft.match = { score: best.score, signals: best.signals, candidateName: best.name };
      continue;
    }

    /**
     * Between the two thresholds, nothing is written at all.
     *
     * Phase 1 created a second record here and left the duplicate queue to catch
     * it. That is a speculative write, and an import performs it at scale: a
     * file of near-matches silently doubles a customer list, and the person who
     * approved the preview was told "created separately for review" in a row
     * sample they did not read. Holding the row costs them a queue item; writing
     * it costs them a merge they may never notice is needed.
     */
    survivor.draft.action = "review";
    survivor.draft.reason =
      `Looks like "${best.name}", but not close enough to be sure. ` +
      "Held for review rather than creating a second record.";
    survivor.draft.matchedRecordId = best.partyId;
    survivor.draft.match = { score: best.score, signals: best.signals, candidateName: best.name };
  }
}
