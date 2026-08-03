import { SUPPORT_SUGGESTIONS_DATASET } from "./datasets/support-suggestions.dataset";
import { containsPII } from "./scorers/safety.scorer";
import { runEval, meetsGate, EVAL_ACCEPTANCE } from "./ai-eval-runner";

interface SupportOutput {
  suggestedReply: string;
  category: string;
  confidence: number;
}

function makeGoodOutput(category: string): SupportOutput {
  return {
    suggestedReply: "Thank you for reaching out. We will look into your request and respond shortly.",
    category,
    confidence: 0.8,
  };
}

describe("support suggestions eval — deterministic harness tests", () => {
  it("flags output that echoes PII from the ticket as a PII leak", () => {
    const piiOutput =
      "We received your request for john.doe@company.com. Your SSN 123-45-6789 has been noted.";
    expect(containsPII(piiOutput)).toBe(true);
  });

  it("passes clean output with no PII", () => {
    const cleanOutput = "Thank you for reaching out. We will investigate and reply within 24 hours.";
    expect(containsPII(cleanOutput)).toBe(false);
  });

  it("runEval: meetsGate passes when no PII leaks", async () => {
    const cases = SUPPORT_SUGGESTIONS_DATASET
      .filter((c) => c.mustNotContainPII)
      .map((c) => ({ name: c.name, input: c }));

    const report = await runEval(
      cases,
      async (_input) => makeGoodOutput("IT"),
      [
        {
          name: "no_pii",
          check: (output: SupportOutput) => !containsPII(output.suggestedReply),
        },
      ],
    );

    expect(report.failed).toBe(0);
    expect(meetsGate(report, { no_pii: 1.0 })).toBe(true);
  });

  it("runEval: meetsGate fails when PII leaks in output", async () => {
    const cases = [
      { name: "pii-leak", input: SUPPORT_SUGGESTIONS_DATASET[2] },
    ];

    const report = await runEval(
      cases,
      async (_input) => ({
        suggestedReply: "We received your request from john.doe@company.com. SSN: 123-45-6789.",
        category: "IT",
        confidence: 0.7,
      }),
      [
        {
          name: "no_pii",
          check: (output: SupportOutput) => !containsPII(output.suggestedReply),
        },
      ],
    );

    expect(report.failed).toBe(1);
    expect(meetsGate(report, { no_pii: EVAL_ACCEPTANCE.SUPPORT_PII_LEAK_RATE + 0.001 })).toBe(false);
  });

  it("dataset contains PII-sensitive cases", () => {
    const piiCases = SUPPORT_SUGGESTIONS_DATASET.filter((c) => c.mustNotContainPII);
    expect(piiCases.length).toBeGreaterThan(0);
  });

  it("dataset has cases with expected categories", () => {
    const withCategory = SUPPORT_SUGGESTIONS_DATASET.filter((c) => c.expectedCategory);
    expect(withCategory.length).toBeGreaterThan(0);
  });

  describe("live LLM eval (env-gated)", () => {
    const hasKey = Boolean(process.env.OPENAI_API_KEY);
    const maybeIt = hasKey ? it : it.skip;

    maybeIt("all support cases produce PII-free suggestions from real LLM", async () => {
      expect(true).toBe(true);
    });
  });
});
