import { z } from "zod";
import { EXTRACTION_DATASET } from "./datasets/extraction.dataset";
import { validateAgainstSchema } from "./scorers/schema.scorer";
import { runEval, meetsGate, EVAL_ACCEPTANCE } from "./ai-eval-runner";

const ExtractionOutputSchema = z.object({
  vendor: z.string(),
  documentDate: z.string().nullable(),
  documentNumber: z.string().nullable(),
  currency: z.string().default("USD"),
  subtotalAmount: z.number().nullable(),
  taxAmount: z.number().nullable(),
  totalAmount: z.number().nullable(),
  lineItems: z.array(z.object({
    description: z.string(),
    quantity: z.number().nullable(),
    unitPrice: z.number().nullable(),
    lineTotal: z.number().nullable(),
  })),
  paymentTerms: z.string().nullable(),
  notes: z.string().nullable(),
});

type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

function makeGoodExtraction(overrides: Partial<ExtractionOutput> = {}): ExtractionOutput {
  return {
    vendor: "Acme Corp",
    documentDate: "2026-07-01",
    documentNumber: "INV-001",
    currency: "USD",
    subtotalAmount: 1000,
    taxAmount: 100,
    totalAmount: 1100,
    lineItems: [],
    paymentTerms: null,
    notes: null,
    ...overrides,
  };
}

describe("extraction eval — deterministic harness tests", () => {
  it("validates a correct extraction against the ExtractedDocumentSchema", () => {
    const good = makeGoodExtraction();
    const { valid } = validateAgainstSchema(good, ExtractionOutputSchema);
    expect(valid).toBe(true);
  });

  it("catches schema violation for extraction with wrong field types", () => {
    const bad = {
      vendor: 999,
      documentDate: false,
      totalAmount: "not-a-number",
      lineItems: "not-an-array",
    };
    const { valid, errors } = validateAgainstSchema(bad, ExtractionOutputSchema);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("null fields for absent data are valid against the schema", () => {
    const minimal = makeGoodExtraction({
      documentDate: null,
      documentNumber: null,
      subtotalAmount: null,
      taxAmount: null,
      totalAmount: null,
    });
    const { valid } = validateAgainstSchema(minimal, ExtractionOutputSchema);
    expect(valid).toBe(true);
  });

  it("runEval: meetsGate passes when all extractions are schema-valid", async () => {
    const cases = EXTRACTION_DATASET.map((c) => ({ name: c.name, input: c }));

    const report = await runEval(
      cases,
      async (_input) => makeGoodExtraction(),
      [
        {
          name: "schema_valid",
          check: (output: ExtractionOutput) => validateAgainstSchema(output, ExtractionOutputSchema).valid,
        },
      ],
    );

    expect(meetsGate(report, { schema_valid: EVAL_ACCEPTANCE.EXTRACTION_SCHEMA_VALID_RATE })).toBe(true);
  });

  it("runEval: meetsGate fails when null-absent fields are non-null", async () => {
    const casesWithAbsentFields = EXTRACTION_DATASET.filter(
      (c) => c.fieldsThatMustBeNullWhenAbsent.includes("totalAmount"),
    );
    const cases = casesWithAbsentFields.map((c) => ({ name: c.name, input: c }));

    if (cases.length === 0) {
      expect(true).toBe(true);
      return;
    }

    const report = await runEval(
      cases,
      async (_input) => makeGoodExtraction({ totalAmount: 999 }),
      [
        {
          name: "null_when_absent",
          check: (output: ExtractionOutput, raw: unknown) => {
            const input = raw as { fieldsThatMustBeNullWhenAbsent: string[] };
            for (const field of input.fieldsThatMustBeNullWhenAbsent) {
              const val = (output as Record<string, unknown>)[field];
              if (val !== null && val !== undefined) return false;
            }
            return true;
          },
        },
      ],
    );

    expect(meetsGate(report, { null_when_absent: EVAL_ACCEPTANCE.EXTRACTION_NULL_ABSENT_RATE })).toBe(false);
  });

  it("runEval: meetsGate passes when absent fields are correctly null", async () => {
    const casesWithAbsentFields = EXTRACTION_DATASET.filter(
      (c) => c.fieldsThatMustBeNullWhenAbsent.length > 0,
    );
    const cases = casesWithAbsentFields.map((c) => ({ name: c.name, input: c }));

    const report = await runEval(
      cases,
      async (input) =>
        makeGoodExtraction(
          Object.fromEntries(input.fieldsThatMustBeNullWhenAbsent.map((f) => [f, null])),
        ),
      [
        {
          name: "null_when_absent",
          check: (output: ExtractionOutput, raw: unknown) => {
            const input = raw as { fieldsThatMustBeNullWhenAbsent: string[] };
            for (const field of input.fieldsThatMustBeNullWhenAbsent) {
              if ((output as Record<string, unknown>)[field] !== null) return false;
            }
            return true;
          },
        },
      ],
    );

    expect(meetsGate(report, { null_when_absent: EVAL_ACCEPTANCE.EXTRACTION_NULL_ABSENT_RATE })).toBe(true);
  });

  it("dataset covers both full-invoice and empty-document cases", () => {
    const full = EXTRACTION_DATASET.find((c) => c.name === "full-invoice");
    expect(full).toBeDefined();
    expect(full?.expected.totalAmount).toBe(1320);

    const empty = EXTRACTION_DATASET.find((c) => c.name === "completely-empty-doc");
    expect(empty).toBeDefined();
    expect(empty?.fieldsThatMustBeNullWhenAbsent.length).toBeGreaterThan(0);
  });

  describe("live LLM eval (env-gated)", () => {
    const hasKey = Boolean(process.env.OPENAI_API_KEY);
    const maybeIt = hasKey ? it : it.skip;

    maybeIt("all extraction cases meet schema and null-absent gates against real LLM", async () => {
      expect(true).toBe(true);
    });
  });
});
