export interface EvalCase<TInput, TOutput> {
  name: string;
  input: TInput;
  expectedOutput?: TOutput;
}

export interface EvalCriterion<TOutput> {
  name: string;
  check: (output: TOutput, input: unknown) => boolean | Promise<boolean>;
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
  /** Zero tolerance: a false merge fuses two customers' histories. */
  DUPLICATE_NO_FALSE_MERGE_RATE: 1.0,
  DUPLICATE_RECALL: 0.9,
  DUPLICATE_OBVIOUS_MERGE_RATE: 1.0,
} as const;

export async function runEval<TInput, TOutput>(
  cases: readonly EvalCase<TInput, TOutput>[],
  produceOutput: (input: TInput) => Promise<TOutput>,
  criteria: EvalCriterion<TOutput>[],
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

export function meetsGate(
  report: EvalReport,
  thresholds: Record<string, number>,
): boolean {
  const total = report.total;
  if (total === 0) return true;

  for (const [criterionName, threshold] of Object.entries(thresholds)) {
    const stat = report.byCriterion[criterionName];
    if (!stat) continue;
    const rate = stat.passed / total;
    if (rate < threshold) return false;
  }

  return true;
}
