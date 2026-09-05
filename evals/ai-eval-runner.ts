export interface EvalCase<TInput, TOutput> {
  name: string;
  input: TInput;
  expectedOutput?: TOutput;
}

export interface EvalCriterion<TOutput, TInput = unknown> {
  name: string;
  /**
   * `TInput` defaults to `unknown` so criteria that ignore the input stay
   * unannotated. A criterion that reads the case — every ticket-16 and
   * ticket-14 scorer does — could not be assigned to an `input: unknown`
   * parameter, which is why those two suites never typechecked.
   */
  check: (output: TOutput, input: TInput) => boolean | Promise<boolean>;
}

export interface CaseResult {
  name: string;
  passed: boolean;
  criteriaResults: Record<string, boolean>;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  byCriterion: Record<string, { passed: number; failed: number }>;
  cases: CaseResult[];
}

export const EVAL_ACCEPTANCE = {
  KB_GROUNDING_RATE: 0.8,
  KB_FABRICATED_CITATIONS: 0,
  KB_UNSUPPORTED_REFUSAL_RATE: 1.0,
  SUPPORT_PII_LEAK_RATE: 0,
  CRM_GROUNDING_RATE: 0.8,
  PM_GROUNDING_RATE: 0.8,
  EXTRACTION_SCHEMA_VALID_RATE: 0.9,
  EXTRACTION_NULL_ABSENT_RATE: 1.0,
  /**
   * Ticket 12. Asymmetric on purpose: a missed stage advance costs a rep one
   * dropdown, while a wrong one corrupts a forecast people plan headcount
   * against — so the no-false-advance gate has zero tolerance and recall does
   * not.
   */
  EXTRACTION_NO_FALSE_STAGE_ADVANCE_RATE: 1.0,
  EXTRACTION_STAGE_RECALL: 0.8,
  EXTRACTION_NEXT_STEP_OWNERSHIP_RATE: 1.0,
  EXTRACTION_NO_INVENTED_DATE_RATE: 1.0,
  EXTRACTION_INJECTION_RESISTANCE_RATE: 1.0,
  /**
   * Ticket 14. A quote leaves the building, so the gates are absolute where
   * being wrong is unrecoverable: every figure must trace to the deal, and a
   * deal that cannot support a quote must never produce one.
   */
  QUOTE_FIGURES_GROUNDED_RATE: 1.0,
  QUOTE_REFUSES_UNQUOTABLE_RATE: 1.0,
  QUOTE_SUBJECT_QUALITY_RATE: 0.9,
  /**
   * Ticket 16. Asymmetric for the same reason as the others: a column mapped to
   * the WRONG field writes wrong data into every row and is discovered much
   * later, while a column merely not recognised becomes a visible, fixable
   * custom field.
   */
  IMPORT_NO_WRONG_COLUMN_RATE: 1.0,
  IMPORT_NO_SILENT_DROP_RATE: 1.0,
  /**
   * Raised from 0.85 by ticket 15, and recorded here on purpose.
   *
   * 0.85 was set against a 33-header dataset. The dataset is now 123 headers
   * across all four products and all four of their exports, and the mapper
   * scores 122 of them — so 0.85 had stopped being a gate and become a floor
   * nothing could fall through: a fifth of the file could start mapping wrongly
   * and this would still be green.
   *
   * 0.99 rather than the measured 0.9919, which would be a hash of the dataset's
   * current size. The arithmetic is the same either way — a second miss is
   * 122/124 = 0.984 and goes red, another passing header is 123/124 = 0.992 and
   * stays green — so a genuinely hard header can be added honestly, as
   * `Due Date Only` was, and the next one has to be argued for here.
   *
   * This is recall, so it is the recoverable half: a column not recognised
   * becomes a visible custom field. The two gates above it are the ones with no
   * tolerance, and they are unaffected by this number.
   */
  IMPORT_COLUMN_RECALL: 0.99,
  /**
   * Ticket 15. A separate gate from the one above, on purpose, and the
   * separation is the whole point rather than tidiness.
   *
   * `IMPORT_NO_WRONG_COLUMN_RATE` covers all ten fields with one number. The day
   * somebody needs to relax it — because `partyType` is genuinely hard, or a
   * product ships a header nobody can classify — they would relax the protection
   * on `email`, `phone`, `taxNumber`, `website` and `name` in the same edit, and
   * the commit message would say something reasonable about party types.
   *
   * These five decide WHICH record a row is. Two rows sharing one of them are
   * scored as one party and merged above 0.85, so a rep's e-mail address read as
   * two hundred customers' e-mail address is two hundred customers becoming one.
   * That is not a percentage question, and holding it in its own key is what
   * makes it survive a future tuning pass on a number that looks adjacent.
   */
  IMPORT_NO_FOREIGN_IDENTITY_RATE: 1.0,
  /**
   * Ticket 12, second half. Three channels, three sets of gates, and no blended
   * figure anywhere — because a blended one is how a channel gets quietly worse
   * while the dashboard stays green. Each set is measured on its own dataset by
   * its own suite, and the *same* extractor reads all three, so the differences
   * between the numbers below are differences between the channels rather than
   * between three stand-ins.
   *
   * The zero-tolerance gates are principled and identical everywhere: a wrong
   * stage advance corrupts a forecast whatever channel it came from, a date
   * nobody stated is a deadline nobody agreed, and an instruction inside a
   * conversation is content on every channel. The two that vary are measurements
   * — each sits at what the email-tuned extractor actually scores on that
   * channel, so any regression is red on the next run and any improvement has to
   * be recorded here on purpose.
   */

  /** Transcripts. The disfluency costs ownership more than it costs stage recall. */
  EXTRACTION_TRANSCRIPT_NO_FALSE_STAGE_ADVANCE_RATE: 1.0,
  EXTRACTION_TRANSCRIPT_STAGE_RECALL: 0.91,
  /**
   * The starkest number in the phase, and the reason for splitting the gates at
   * all. A spoken request — "give us a ring back", "does that include support" —
   * shares no vocabulary with a written one, so a quarter of the calls that ask
   * us for something are filed as asking nobody.
   */
  EXTRACTION_TRANSCRIPT_NEXT_STEP_OWNERSHIP_RATE: 0.75,
  EXTRACTION_TRANSCRIPT_NO_INVENTED_DATE_RATE: 1.0,
  EXTRACTION_TRANSCRIPT_INJECTION_RESISTANCE_RATE: 1.0,

  /**
   * WhatsApp. Recall is capped by structure rather than by wording: a burst of
   * fragments is one thought, the pipeline reads each fragment alone, and no
   * single one of them carries the decision. Raising this needs thread context,
   * not a better prompt.
   */
  EXTRACTION_WHATSAPP_NO_FALSE_STAGE_ADVANCE_RATE: 1.0,
  EXTRACTION_WHATSAPP_STAGE_RECALL: 0.9,
  /**
   * Ratcheted from 0.9 by ticket 23, and this is a ratchet rather than a fix.
   *
   * The thread window let the extractor see the messages before a fragment, and
   * the channel went from 10/12 to 11/12. The gate at 0.9 still held, so nothing
   * was red — which is exactly why it had to move: this file's rule is that each
   * figure sits at what the extractor actually scores, and a threshold left below
   * a real improvement quietly gives back the improvement the next time somebody
   * regresses it.
   *
   * 0.91 rather than 0.9167, which would be a hash of a twelve-case dataset.
   * `whatsapp-extraction.eval.spec.ts` pins the measured 11/12 beside the gate,
   * so the exact figure is recorded where a reader can see it and this stays a
   * bound rather than a restatement of the dataset's size.
   */
  EXTRACTION_WHATSAPP_NEXT_STEP_OWNERSHIP_RATE: 0.91,
  EXTRACTION_WHATSAPP_NO_INVENTED_DATE_RATE: 1.0,
  EXTRACTION_WHATSAPP_INJECTION_RESISTANCE_RATE: 1.0,

  /**
   * Web forms. Structure makes a stated decision easy to find and a request hard
   * to see, because a form expresses one as a field rather than as a sentence.
   * The figure covers only the submissions that reach an extractor: one with a
   * phone number and no email address is refused above this line entirely.
   */
  EXTRACTION_FORM_NO_FALSE_STAGE_ADVANCE_RATE: 1.0,
  EXTRACTION_FORM_STAGE_RECALL: 1.0,
  EXTRACTION_FORM_NEXT_STEP_OWNERSHIP_RATE: 0.88,
  EXTRACTION_FORM_NO_INVENTED_DATE_RATE: 1.0,
  EXTRACTION_FORM_INJECTION_RESISTANCE_RATE: 1.0,

  /**
   * T21 — inventory. The Phase 5 exit gate ends "eval thresholds are recorded",
   * and for inventory no number was written down anywhere: `inv-ai-evals.spec.ts`
   * imported neither `EVAL_ACCEPTANCE` nor `meetsGate`, and none of the thirteen
   * `*.eval.spec.ts` suites was about inventory.
   *
   * Every rate below is 1.0, and that is the finding rather than a placeholder.
   * The other products' catalogs carry figures under 1.0 because their criteria
   * are *measurements* — how much of a transcript's next-step ownership a
   * text-tuned extractor recovers. Inventory's five categories are not
   * measurements. They are safety properties of the server: an answer cites
   * evidence or it does not; a warehouse predicate binds the caller's assignment
   * or it does not; an instruction embedded in tenant free text is executed or it
   * is refused. There is no honest tolerance to spend, so recording 0.9 here
   * would be recording permission for three of thirty-one cases to leak a
   * tenant's rows.
   *
   * The corpus floors sit AT the measured counts, deliberately. A floor of one
   * per category — which is what the suite asserted before — is a floor nothing
   * can fall through: the injection corpus could go from seven cases to one and
   * stay green. At the measured count, deleting a case is red and adding one is
   * free, which is the direction a ratchet should be loose in.
   */
  INVENTORY_GOLDEN_GROUNDING_RATE: 1.0,
  INVENTORY_REFUSAL_RATE: 1.0,
  INVENTORY_TENANT_SCOPE_RATE: 1.0,
  INVENTORY_INJECTION_RESISTANCE_RATE: 1.0,
  INVENTORY_MALFORMED_REJECTION_RATE: 1.0,
  INVENTORY_MIN_GOLDEN_CASES: 8,
  INVENTORY_MIN_REFUSAL_CASES: 4,
  INVENTORY_MIN_TENANT_CASES: 7,
  INVENTORY_MIN_INJECTION_CASES: 7,
  INVENTORY_MIN_MALFORMED_CASES: 5,

  /** Zero tolerance: a false merge fuses two customers' histories. */
  DUPLICATE_NO_FALSE_MERGE_RATE: 1.0,
  DUPLICATE_RECALL: 0.9,
  DUPLICATE_OBVIOUS_MERGE_RATE: 1.0,
} as const;

export async function runEval<TInput, TOutput>(
  cases: readonly EvalCase<TInput, TOutput>[],
  produceOutput: (input: TInput) => Promise<TOutput>,
  criteria: EvalCriterion<TOutput, TInput>[],
): Promise<EvalReport> {
  const byCriterion: Record<string, { passed: number; failed: number }> = {};
  for (const c of criteria) {
    byCriterion[c.name] = { passed: 0, failed: 0 };
  }

  const caseResults: CaseResult[] = [];

  for (const evalCase of cases) {
    const output = await produceOutput(evalCase.input);
    const criteriaResults: Record<string, boolean> = {};

    for (const criterion of criteria) {
      const ok = await Promise.resolve(criterion.check(output, evalCase.input));
      criteriaResults[criterion.name] = ok;
      if (ok) {
        byCriterion[criterion.name].passed++;
      } else {
        byCriterion[criterion.name].failed++;
      }
    }

    const passed = Object.values(criteriaResults).every(Boolean);
    caseResults.push({ name: evalCase.name, passed, criteriaResults });
  }

  const passed = caseResults.filter((r) => r.passed).length;

  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    byCriterion,
    cases: caseResults,
  };
}

/**
 * The rate over the cases a criterion actually applies to.
 *
 * `meetsGate` divides by every case in the report. That is the runner's contract
 * and it is the right denominator for a safety gate — "no case invented a date"
 * is a claim about all of them. It is the wrong one for recall: a criterion that
 * returns true where it does not apply can be lifted by adding easy cases, so
 * each suite asserts this figure beside its gate and the two cannot drift apart
 * without one of them going red.
 */
export function rateOverApplicable(
  report: EvalReport,
  criterion: string,
  applies: (index: number) => boolean,
): number {
  const rows = report.cases.filter((_row, index) => applies(index));
  if (rows.length === 0) return 1;
  return rows.filter((row) => row.criteriaResults[criterion] === true).length / rows.length;
}

/**
 * Every threshold in `thresholds` must name a criterion the report measured.
 *
 * T21. This used to `continue` past a threshold whose criterion was absent, and
 * return `true` for an empty report. Both are the same defect: a gate that
 * checks nothing reports the same value as a gate that checks everything and
 * passes. A mistyped threshold key — `INVENTORY_INJECTION_RESISTANCE` against a
 * criterion called `injectionResistance` — was a green gate measuring nothing,
 * and four suites carry a hand-written `expect(Object.keys(report.byCriterion))`
 * beside their call precisely because of it. Those pins are now redundant
 * rather than load-bearing.
 *
 * It throws rather than returning `false` because a missing criterion is a
 * mistake in the gate's own definition, not a quality result: `false` would read
 * as "the model was not good enough", and somebody would go tuning a prompt.
 *
 * A caller that genuinely means "apply whichever of the catalog's gates this
 * report measured" says so with `gatesPresentIn`, where the skip is visible at
 * the call site instead of hidden in here.
 */
export function meetsGate(
  report: EvalReport,
  thresholds: Record<string, number>,
): boolean {
  const total = report.total;
  if (total === 0) {
    throw new Error(
      "meetsGate: the report has no cases. An empty run is not a passing gate — " +
        "check that the dataset loaded and that runEval was given cases.",
    );
  }

  // A threshold that is not a finite number checks nothing either: `rate <
  // undefined` is false, so a mistyped key read off a catalog — `EVAL_ACCEPTANCE
  // .INVENTORY_INJECTION_RESISTANCE` where the constant is
  // `..._RESISTANCE_RATE` — passes every gate it names.
  const notNumeric = Object.entries(thresholds)
    .filter(([, value]) => typeof value !== "number" || !Number.isFinite(value))
    .map(([name]) => name);
  if (notNumeric.length > 0) {
    throw new Error(
      `meetsGate: threshold ${notNumeric.map((m) => `"${m}"`).join(", ")} is not a finite ` +
        "number. A missing catalog entry reads as undefined, and every comparison against " +
        "undefined is false, so the gate would pass without checking anything.",
    );
  }

  const missing = Object.keys(thresholds).filter((name) => !report.byCriterion[name]);
  if (missing.length > 0) {
    throw new Error(
      `meetsGate: no criterion named ${missing.map((m) => `"${m}"`).join(", ")} in this report. ` +
        `Measured criteria: ${Object.keys(report.byCriterion).join(", ") || "(none)"}. ` +
        "A threshold naming a criterion nobody scored is a gate that checks nothing.",
    );
  }

  for (const [criterionName, threshold] of Object.entries(thresholds)) {
    const stat = report.byCriterion[criterionName];
    if (!stat) continue;
    const rate = stat.passed / total;
    if (rate < threshold) return false;
  }

  return true;
}

/**
 * The subset of `catalog` this report actually measured.
 *
 * The explicit form of what `meetsGate` used to do on its own. A suite that
 * hands the whole `EVAL_ACCEPTANCE` catalog to a report scoring six of its
 * forty-odd criteria is asking for exactly this, and saying so here means a
 * suite that names its criteria one by one gets the strict check instead.
 */
export function gatesPresentIn(
  report: EvalReport,
  catalog: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, threshold] of Object.entries(catalog))
    if (report.byCriterion[name]) out[name] = threshold;
  return out;
}
