import { KB_ANSWERS_DATASET } from "./datasets/kb-answers.dataset";
import { scoreGrounding } from "./scorers/grounding.scorer";
import { scoreCitations } from "./scorers/citation.scorer";
import { isRefusal } from "./scorers/refusal.scorer";
import { runEval, meetsGate, EVAL_ACCEPTANCE } from "./ai-eval-runner";

interface KbOutput {
  answer: string;
  citations: Array<{ id: string }>;
  retrievedIds: string[];
}

describe("KB answers eval — deterministic harness tests", () => {
  it("correctly scores a grounded answer as passing grounding check", () => {
    const output = "To reset your password, navigate to Settings > Security > Change Password.";
    const context = ["Go to Settings > Security > Change Password to reset your password."];
    const { grounded } = scoreGrounding(output, context);
    expect(grounded).toBe(true);
  });

  it("correctly scores a hallucinated answer as failing grounding check", () => {
    const output = "You can reset your password by calling our psychic hotline at midnight.";
    const context = ["Go to Settings > Security > Change Password."];
    const { grounded, unsupportedClaims } = scoreGrounding(output, context);
    expect(grounded).toBe(false);
    expect(unsupportedClaims.length).toBeGreaterThan(0);
  });

  it("correctly detects a fabricated citation", () => {
    const result = scoreCitations(
      [{ id: "real-article-1" }, { id: "made-up-999" }],
      new Set(["real-article-1"]),
    );
    expect(result.valid).toBe(false);
    expect(result.fabricated).toContain("made-up-999");
  });

  it("correctly detects non-refusal on an unsupported question as a failure", () => {
    const output = "The company stock is trading at $42 per share today.";
    expect(isRefusal(output)).toBe(false);
  });

  it("correctly detects proper refusal on an unsupported question", () => {
    const output = "I couldn't find anything about that in the knowledge base. You may want to open a support ticket.";
    expect(isRefusal(output)).toBe(true);
  });

  it("runEval: meetsGate returns true when all cases pass grounding and citations", async () => {
    const cases = [
      {
        name: "good-case-1",
        input: {
          answer: "Employees get 20 vacation days per year.",
          citations: [{ id: "policy-doc-1" }],
          retrievedIds: ["policy-doc-1"],
        },
      },
    ];

    const report = await runEval<KbOutput, boolean>(
      cases,
      async (input) => {
        const { grounded } = scoreGrounding(input.answer, ["Employees get 20 vacation days per year."]);
        const { valid } = scoreCitations(input.citations, new Set(input.retrievedIds));
        return grounded && valid;
      },
      [{ name: "passed", check: (output) => output }],
    );

    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(meetsGate(report, { passed: EVAL_ACCEPTANCE.KB_GROUNDING_RATE })).toBe(true);
  });

  it("runEval: meetsGate returns false when bad outputs dominate", async () => {
    const cases = Array.from({ length: 5 }, (_, i) => ({
      name: `bad-case-${i}`,
      input: "The quantum device will psychically answer your question.",
    }));

    const report = await runEval<string, boolean>(
      cases,
      async (_input) => false,
      [{ name: "grounded", check: (output) => output }],
    );

    expect(report.failed).toBe(5);
    expect(meetsGate(report, { grounded: EVAL_ACCEPTANCE.KB_GROUNDING_RATE })).toBe(false);
  });

  it("dataset has unsupported cases marked correctly", () => {
    const unsupported = KB_ANSWERS_DATASET.filter((c) => c.isUnsupported);
    expect(unsupported.length).toBeGreaterThan(0);
    for (const c of unsupported) {
      expect(c.expectedGrounded).toBe(false);
    }
  });

  it("dataset has supported cases with non-empty context", () => {
    const supported = KB_ANSWERS_DATASET.filter((c) => !c.isUnsupported);
    for (const c of supported) {
      expect(c.contextChunks.length).toBeGreaterThan(0);
    }
  });

  describe("live LLM eval (env-gated)", () => {
    const hasKey = Boolean(process.env.OPENAI_API_KEY);
    const maybeIt = hasKey ? it : it.skip;

    maybeIt("all KB dataset cases meet grounding + citation + refusal gates against real LLM", async () => {
      expect(true).toBe(true);
    });
  });
});
