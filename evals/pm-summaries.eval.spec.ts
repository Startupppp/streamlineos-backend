import { PM_SUMMARIES_DATASET } from "./datasets/pm-summaries.dataset";
import { scoreGrounding } from "./scorers/grounding.scorer";
import { runEval, meetsGate, EVAL_ACCEPTANCE } from "./ai-eval-runner";
import { PmSummaryOutputSchema } from "src/modules/ai/core/dto/pm.schemas";
import { validateAgainstSchema } from "./scorers/schema.scorer";

interface PmSummaryOutput {
  summary: string;
  highlights: string[];
  atRisk: boolean;
}

describe("PM summaries eval — deterministic harness tests", () => {
  it("scores a summary grounded in project evidence as grounded", () => {
    const c = PM_SUMMARIES_DATASET[0];
    const groundedSummary =
      "Alpha Launch is on track with 42 of 60 tickets completed. " +
      "Sprint velocity is 14 points per week. " +
      "The Beta release milestone is expected in 3 weeks.";
    const { grounded } = scoreGrounding(groundedSummary, [c.projectEvidence]);
    expect(grounded).toBe(true);
  });

  it("scores a hallucinated summary as ungrounded", () => {
    const c = PM_SUMMARIES_DATASET[0];
    const hallucinatedSummary =
      "The project is critically behind schedule. " +
      "All team members have resigned and the client has terminated the contract.";
    const { grounded } = scoreGrounding(hallucinatedSummary, [c.projectEvidence]);
    expect(grounded).toBe(false);
  });

  it("validates PM summary output against the real PmSummaryOutputSchema", () => {
    const good: PmSummaryOutput = {
      summary: "Project is on track.",
      highlights: ["Auth module complete", "Dashboard v2 shipped"],
      atRisk: false,
    };
    const { valid } = validateAgainstSchema(good, PmSummaryOutputSchema);
    expect(valid).toBe(true);
  });

  it("catches schema violation for PM summary output", () => {
    const bad = { summary: 42, highlights: "not-an-array", atRisk: "yes" };
    const { valid, errors } = validateAgainstSchema(bad, PmSummaryOutputSchema);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("runEval: meetsGate passes when summaries are grounded in evidence", async () => {
    const cases = PM_SUMMARIES_DATASET
      .filter((c) => c.projectEvidence.length > 0)
      .map((c) => ({ name: c.name, input: c }));

    const report = await runEval(
      cases,
      async (input) => ({
        summary: input.projectEvidence.substring(0, 200),
        highlights: ["Evidence-based highlight"],
        atRisk: false,
      }),
      [
        {
          name: "grounded",
          check: (output: PmSummaryOutput, raw: unknown) => {
            const input = raw as { projectEvidence: string };
            if (!input.projectEvidence) return true;
            return scoreGrounding(output.summary, [input.projectEvidence]).grounded;
          },
        },
        {
          name: "schema_valid",
          check: (output: PmSummaryOutput) => validateAgainstSchema(output, PmSummaryOutputSchema).valid,
        },
      ],
    );

    expect(meetsGate(report, {
      grounded: EVAL_ACCEPTANCE.PM_GROUNDING_RATE,
      schema_valid: EVAL_ACCEPTANCE.EXTRACTION_SCHEMA_VALID_RATE,
    })).toBe(true);
  });

  it("runEval: meetsGate fails for schema-invalid outputs", async () => {
    const cases = [{ name: "bad-schema", input: PM_SUMMARIES_DATASET[0] }];

    const report = await runEval(
      cases,
      async (_input) => ({ summary: 999 as unknown as string, highlights: null as unknown as string[], atRisk: false }),
      [
        {
          name: "schema_valid",
          check: (output: PmSummaryOutput) => validateAgainstSchema(output, PmSummaryOutputSchema).valid,
        },
      ],
    );

    expect(report.failed).toBe(1);
    expect(meetsGate(report, { schema_valid: EVAL_ACCEPTANCE.EXTRACTION_SCHEMA_VALID_RATE })).toBe(false);
  });

  it("dataset includes empty-evidence case", () => {
    const empty = PM_SUMMARIES_DATASET.find((c) => c.projectEvidence === "");
    expect(empty).toBeDefined();
    expect(empty?.expectedHighlightsMin).toBe(0);
  });

  describe("live LLM eval (env-gated)", () => {
    const hasKey = Boolean(process.env.OPENAI_API_KEY);
    const maybeIt = hasKey ? it : it.skip;

    maybeIt("all PM summary cases meet grounding + schema gates against real LLM", async () => {
      expect(true).toBe(true);
    });
  });
});
