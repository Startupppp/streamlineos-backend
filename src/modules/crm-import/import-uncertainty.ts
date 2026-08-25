import type { ReversibilityClass } from "../../db/schema/crm/autonomous-decisions";
import type { FindingSeverity, ProposedAction } from "../../db/schema/crm/data-quality";
import { ACTION_REVERSIBILITY } from "../data-quality/finding-vocabulary";
import { duplicateSeverity, strongestSignal } from "../data-quality/producer-bands";
import {
  normaliseEmail,
  normaliseHost,
  normaliseName,
  normalisePhone,
  normaliseTaxNumber,
} from "../party/party-duplicates";
import type { RowMatch } from "./import-plan";

/**
 * Turning a row the importer would not guess about into a queued piece of work.
 *
 * Ticket 16 declared `import-uncertainty` in `DATA_QUALITY_PRODUCERS` with a
 * comment saying nothing wrote it, and deliberately left it out of
 * `SWEEPABLE_PRODUCERS`. This is the producer it was waiting for, and it stays
 * out of the sweepable set for the reason that exclusion was right in the first
 * place: a sweep re-derives its findings from the current state of the database,
 * and there is no state to re-derive from here. The uncertainty existed for the
 * duration of one import and is only knowable from the plan that recorded it.
 *
 * The queue's own rule is obeyed rather than restated: **`groupKey` determines
 * `severity`**, so the band is inside the key. The band itself comes from
 * `producer-bands`, which reads it off `AUTO_MERGE_THRESHOLD` and
 * `REVIEW_THRESHOLD` — the same numbers that put the row under review. A second
 * set of bands here would let the queue and the importer disagree about the same
 * pair of records, which is the failure the whole "one scorer" rule exists to
 * prevent.
 */

/** What the queue's insert needs, in the order `data_quality_findings` holds it. */
export interface UncertaintyFinding {
  readonly producer: "import-uncertainty";
  readonly findingKind: string;
  readonly subjectKey: string;
  readonly groupKey: string;
  readonly severity: FindingSeverity;
  readonly partyId: string;
  readonly evidence: Record<string, unknown>;
  readonly score: number;
  readonly proposedAction: ProposedAction;
  readonly reversibility: ReversibilityClass;
}

export interface UncertainRow {
  readonly crmImportId: string;
  readonly rowNumber: number;
  /** The existing party the row looked like. A review row always has one. */
  readonly matchedPartyId: string;
  readonly match: RowMatch;
  readonly values: Readonly<Record<string, string>>;
  readonly reason?: string | null;
  readonly sourceFilename?: string | null;
}

/**
 * The strongest identifier the row carries, normalised.
 *
 * The dedupe key has to survive the same file being imported twice, which is
 * what an evaluation actually looks like — upload, look at the mess, fix the
 * spreadsheet, upload again. Keyed on the import or the row number, the second
 * upload would file a second finding for a decision nobody has taken yet and
 * the queue would grow a copy per attempt. Keyed on what the row *is*, it
 * refreshes the finding already there.
 *
 * Normalised with the scorer's own functions, so two spellings of one e-mail
 * address are one subject here exactly as they are one match there.
 */
export function rowIdentityKey(values: Readonly<Record<string, string>>): string {
  const tax = normaliseTaxNumber(values.taxNumber);
  if (tax) return `t:${tax}`;

  const email = normaliseEmail(values.email);
  if (email) return `e:${email}`;

  const phone = normalisePhone(values.phone);
  if (phone) return `p:${phone}`;

  const host = normaliseHost(values.website);
  if (host) return `h:${host}`;

  // A row with no identifier cannot have reached the review threshold on
  // anything but its name, so the name is genuinely all there is to key on.
  return `n:${normaliseName(values.name)}`;
}

/** Signal and band both, so one group is one severity and one decision. */
export function uncertaintyGroupKey(
  signals: readonly string[],
  severity: FindingSeverity,
): string {
  return `import-uncertainty:${strongestSignal(signals)}:${severity}`;
}

/**
 * One held row, as a finding.
 *
 * `proposedAction` is `none`, and that is the honest answer rather than a
 * missing feature. The two actions the queue can execute are `merge-parties`
 * and nothing, and there is no second party to merge: the whole point of holding
 * the row is that it was never written. What a person does with it is decide
 * whether the file's row is the party it resembles, which they do against the
 * import — so the finding's job is to make sure somebody is asked.
 */
export function uncertaintyFinding(row: UncertainRow): UncertaintyFinding {
  const severity = duplicateSeverity(row.match.score);

  return {
    producer: "import-uncertainty",
    findingKind: "import-uncertainty.near-duplicate",
    subjectKey: `${row.matchedPartyId}:${rowIdentityKey(row.values)}`,
    groupKey: uncertaintyGroupKey(row.match.signals, severity),
    severity,
    partyId: row.matchedPartyId,
    evidence: {
      crmImportId: row.crmImportId,
      sourceFilename: row.sourceFilename ?? null,
      rowNumber: row.rowNumber,
      reason: row.reason ?? null,
      score: row.match.score,
      signals: [...row.match.signals],
      candidateName: row.match.candidateName ?? null,
      /** The row as it would have been written, so the judgement needs no re-run. */
      values: { ...row.values },
    },
    score: row.match.score,
    proposedAction: "none",
    // Taken from the action, never chosen here: two producers proposing the same
    // action must not disagree about whether it can be taken back.
    reversibility: ACTION_REVERSIBILITY.none,
  };
}
