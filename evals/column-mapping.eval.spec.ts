import { EVAL_ACCEPTANCE, meetsGate, runEval } from "./ai-eval-runner";
import { COLUMN_MAPPING_DATASET, type ColumnCase } from "./datasets/column-mapping.dataset";
import { mapColumn } from "../src/modules/crm-import/column-mapping";

/**
 * The gate on column mapping.
 *
 * The asymmetry is the point. Mapping a column to the *wrong* field writes
 * wrong data into every row of the file and the user finds out much later, so
 * that gate has zero tolerance. Failing to recognise a column is recoverable —
 * it becomes a custom field, which is visible and fixable — so recall is high
 * rather than absolute.
 */
function classify(header: string): string | null | "custom" {
  const mapping = mapColumn(header);
  switch (mapping.kind) {
    case "mapped":
      return mapping.field;
    case "custom":
      return "custom";
    case "unmapped":
      return null;
    case "ambiguous":
      // Not an answer. Counted as a miss for recall, never as a wrong mapping.
      return "__ambiguous__";
  }
}

describe("column mapping evals", () => {
  const cases = COLUMN_MAPPING_DATASET.map((c) => ({ name: `${c.product}: ${c.header}`, input: c }));

  it("meets every acceptance gate", async () => {
    const report = await runEval(cases, async (input) => classify(input.header), [
      {
        /**
         * Zero tolerance. A column mapped to the wrong field is wrong data in
         * every row, discovered long afterwards.
         */
        name: "IMPORT_NO_WRONG_COLUMN_RATE",
        check: (output, input: ColumnCase) => {
          if (output === "__ambiguous__") return true; // a refusal, not a mistake
          const isRealField = output !== null && output !== "custom";
          const expectedRealField = input.expected !== null && input.expected !== "custom";
          // Wrong only when it confidently named a different field.
          if (isRealField && expectedRealField) return output === input.expected;
          if (isRealField && !expectedRealField) return false;
          return true;
        },
      },
      {
        name: "IMPORT_COLUMN_RECALL",
        check: (output, input: ColumnCase) => output === input.expected,
      },
      {
        /**
         * A column the user can see in their file and cannot find afterwards is
         * data loss they discover months later.
         */
        name: "IMPORT_NO_SILENT_DROP_RATE",
        check: (output, input: ColumnCase) =>
          input.expected === "custom" ? output === "custom" : true,
      },
    ]);

    // Pinned by name: meetsGate silently skips a threshold whose criterion is
    // absent, so a typo in either name is a green gate checking nothing.
    expect(Object.keys(report.byCriterion).sort()).toEqual([
      "IMPORT_COLUMN_RECALL",
      "IMPORT_NO_SILENT_DROP_RATE",
      "IMPORT_NO_WRONG_COLUMN_RATE",
    ]);

    expect(meetsGate(report, EVAL_ACCEPTANCE)).toBe(true);
  });

  it("fails the gate when a mapper starts guessing", async () => {
    // A gate nobody has seen fail is a gate that might check nothing.
    const report = await runEval(cases, async () => "name", [
      {
        name: "IMPORT_NO_WRONG_COLUMN_RATE",
        check: (output, input: ColumnCase) => output === input.expected,
      },
    ]);
    expect(meetsGate(report, EVAL_ACCEPTANCE)).toBe(false);
  });

  it("covers at least two competing products, as the ticket requires", () => {
    const products = new Set(COLUMN_MAPPING_DATASET.map((c) => c.product));
    products.delete("generic");
    expect(products.size).toBeGreaterThanOrEqual(2);
  });

  it("carries the qualified headers that decide the accuracy claim", () => {
    // "Company Phone" read as a name puts every phone number in the wrong field.
    const qualified = COLUMN_MAPPING_DATASET.filter((c) => /^(Company|Billing|Customer) /.test(c.header));
    expect(qualified.length).toBeGreaterThanOrEqual(3);
  });
});
