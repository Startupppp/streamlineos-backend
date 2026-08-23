import { PARTY_DUPLICATE_DATASET, type DuplicateCase } from "./datasets/party-duplicates.dataset";
import {
  assessDuplicate,
  type DuplicateAssessment,
} from "../src/modules/party/party-duplicates";
import { runEval, meetsGate, EVAL_ACCEPTANCE } from "./ai-eval-runner";

/**
 * Measures duplicate detection against labelled pairs.
 *
 * Gated in CI because the weighting is a judgement call encoded as numbers, and
 * a change that looks harmless — one more signal, one threshold nudged — is
 * exactly how a false merge gets shipped. Precision and recall are asymmetric on
 * purpose: a missed duplicate is a row someone merges later, a false merge fuses
 * two customers' histories.
 */

function assess(input: DuplicateCase): DuplicateAssessment {
  return assessDuplicate(input.left, input.right);
}

describe("party duplicate detection", () => {
  const results = PARTY_DUPLICATE_DATASET.map((testCase) => ({
    testCase,
    assessment: assess(testCase),
  }));

  const merged = results.filter((row) => row.assessment.verdict === "auto-merge");
  const flagged = results.filter((row) => row.assessment.verdict !== "distinct");
  const duplicates = results.filter((row) => row.testCase.same);

  const truePositives = merged.filter((row) => row.testCase.same).length;
  const falsePositives = merged.filter((row) => !row.testCase.same);

  const precision = merged.length === 0 ? 1 : truePositives / merged.length;
  const recall =
    duplicates.length === 0
      ? 1
      : flagged.filter((row) => row.testCase.same).length / duplicates.length;

  it("never merges two records that are not the same organisation", () => {
    // Zero tolerance. This is the failure the whole weighting exists to prevent,
    // and it is the one a user cannot easily discover after the fact.
    expect(
      falsePositives.map((row) => `${row.testCase.name} (score ${String(row.assessment.score)})`),
    ).toEqual([]);
    expect(precision).toBe(1);
  });

  it("surfaces at least nine in ten real duplicates", () => {
    const missed = duplicates
      .filter((row) => row.assessment.verdict === "distinct")
      .map((row) => row.testCase.name);

    expect(missed).toEqual([]);
    expect(recall).toBeGreaterThanOrEqual(EVAL_ACCEPTANCE.DUPLICATE_RECALL);
  });

  it("merges the obvious duplicates without asking", () => {
    const asked = duplicates
      .filter((row) => row.testCase.obvious && row.assessment.verdict !== "auto-merge")
      .map((row) => row.testCase.name);

    expect(asked).toEqual([]);
  });

  it("gives every merge a reason a human can read", () => {
    for (const row of merged) expect(row.assessment.signals.length).toBeGreaterThan(0);
  });

  it("records the contradiction when two registrations disagree", () => {
    const contradicting = results.filter((row) => row.assessment.blockers.length > 0);
    expect(contradicting.length).toBeGreaterThan(0);
    for (const row of contradicting) expect(row.assessment.verdict).not.toBe("auto-merge");
  });

  it("passes the harness gate", async () => {
    const report = await runEval(
      PARTY_DUPLICATE_DATASET.map((testCase) => ({ name: testCase.name, input: testCase })),
      async (input) => assess(input),
      [
        {
          name: "no-false-merge",
          check: (output, input) =>
            output.verdict !== "auto-merge" || (input as DuplicateCase).same,
        },
        {
          name: "duplicate-surfaced",
          check: (output, input) =>
            !(input as DuplicateCase).same || output.verdict !== "distinct",
        },
        {
          name: "obvious-merged",
          check: (output, input) => {
            const testCase = input as DuplicateCase;
            return !testCase.obvious || output.verdict === "auto-merge";
          },
        },
      ],
    );

    expect(
      meetsGate(report, {
        "no-false-merge": EVAL_ACCEPTANCE.DUPLICATE_NO_FALSE_MERGE_RATE,
        "duplicate-surfaced": EVAL_ACCEPTANCE.DUPLICATE_RECALL,
        "obvious-merged": EVAL_ACCEPTANCE.DUPLICATE_OBVIOUS_MERGE_RATE,
      }),
    ).toBe(true);
  });
});
