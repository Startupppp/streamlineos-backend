import { EVAL_ACCEPTANCE, gatesPresentIn, meetsGate, rateOverApplicable, runEval } from "./ai-eval-runner";
import {
  COLUMN_MAPPING_DATASET,
  type ColumnCase,
  type ColumnSource,
} from "./datasets/column-mapping.dataset";
import { isIdentityField, mapColumn } from "../src/modules/crm/import/column-mapping";

/**
 * The gate on column mapping.
 *
 * Two asymmetries, and they are different asymmetries.
 *
 * The first is about confidence. Mapping a column to the *wrong* field writes
 * wrong data into every row of the file and the user finds out much later, so
 * that gate has zero tolerance. Failing to recognise a column is recoverable —
 * it becomes a custom field, which is visible and fixable — so recall is high
 * rather than absolute.
 *
 * The second is about which field. A wrong `notes` is a paragraph in the wrong
 * place. A wrong `email`, `phone`, `taxNumber`, `website` or `name` is a
 * different customer, because those five are what the duplicate scorer matches
 * on and two rows that share one are merged without asking. `Account Owner
 * Email` read as the customer's address gives one rep's two hundred accounts one
 * identity. That gate is separate from the first so it cannot be relaxed by
 * somebody tuning the first — see `EVAL_ACCEPTANCE`.
 *
 * Nothing here calls a model. `mapColumn` is deterministic by design — the
 * module's own opening paragraph says a CRM header is a lookup rather than a
 * judgement — so the whole suite runs offline and runs in CI on every pull
 * request, which is what the ticket asks for. There is no live block to gate on
 * a key because there is nothing live to gate.
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

/** Whether an answer put the value into a column the row is identified by. */
function landedInIdentityColumn(output: string | null): boolean {
  return output !== null && output !== "custom" && output !== "__ambiguous__"
    ? isIdentityField(output)
    : false;
}

describe("column mapping evals", () => {
  const cases = COLUMN_MAPPING_DATASET.map((c) => ({ name: `${c.product}: ${c.header}`, input: c }));
  const runMappingEval = async () =>
    runEval(cases, async (input) => classify(input.header), [
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
        /**
         * Zero tolerance, and narrower: nothing may reach an identity column
         * unless that column is where it belongs.
         *
         * Deliberately judged on every case rather than only the flagged ones.
         * The flag says which headers were put in the dataset *because* they are
         * traps; the gate is the claim that no header at all lands in the wrong
         * identity column, which is the claim the importer actually has to make.
         */
        name: "IMPORT_NO_FOREIGN_IDENTITY_RATE",
        check: (output, input: ColumnCase) =>
          !landedInIdentityColumn(output) || output === input.expected,
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

  it("meets every acceptance gate", async () => {
    const report = await runMappingEval();

    // Pinned by name: meetsGate silently skips a threshold whose criterion is
    // absent, so a typo in either name is a green gate checking nothing.
    expect(Object.keys(report.byCriterion).sort()).toEqual([
      "IMPORT_COLUMN_RECALL",
      "IMPORT_NO_FOREIGN_IDENTITY_RATE",
      "IMPORT_NO_SILENT_DROP_RATE",
      "IMPORT_NO_WRONG_COLUMN_RATE",
    ]);

    expect(meetsGate(report, gatesPresentIn(report, EVAL_ACCEPTANCE))).toBe(true);
  });

  /**
   * The identity gate, measured over the headers it is about.
   *
   * `meetsGate` divides by every case in the report, which is the right
   * denominator for a safety claim — "nothing landed in the wrong identity
   * column" is a claim about all of them. It is the wrong denominator for
   * knowing the gate has teeth: a criterion that returns true where it does not
   * apply can be held at 1.0 by adding easy headers, and most headers are easy.
   * This is the same figure over the traps alone, so the two cannot drift apart
   * without one of them going red.
   */
  it("holds the identity gate over the traps themselves", async () => {
    const report = await runMappingEval();
    const dataset = COLUMN_MAPPING_DATASET;
    const traps = dataset.filter((c) => c.identityTrap === true);

    // The traps come from four products, so this is not one vendor's quirk.
    expect(new Set(traps.map((c) => c.product)).size).toBeGreaterThanOrEqual(4);
    expect(traps.length).toBeGreaterThanOrEqual(12);

    expect(
      rateOverApplicable(
        report,
        "IMPORT_NO_FOREIGN_IDENTITY_RATE",
        (index) => dataset[index]!.identityTrap === true,
      ),
    ).toBe(1);
  });

  it("fails the gate when a mapper starts guessing", async () => {
    // A gate nobody has seen fail is a gate that might check nothing.
    const report = await runEval(cases, async () => "name", [
      {
        name: "IMPORT_NO_WRONG_COLUMN_RATE",
        check: (output, input: ColumnCase) => output === input.expected,
      },
    ]);
    expect(meetsGate(report, gatesPresentIn(report, EVAL_ACCEPTANCE))).toBe(false);
  });

  /**
   * The negative control for the identity gate specifically.
   *
   * A mapper that reads only the head noun — which is what this one did before
   * ticket 15 — puts `Account Owner Email` in `email` and `Parent Account` in
   * `name`. That is the exact behaviour the gate exists to forbid, so it is
   * worth watching the gate reject it rather than trusting that it would.
   */
  it("fails the identity gate when a mapper reads only the head noun", async () => {
    const headNounOnly = (header: string): string => {
      const last = header.toLowerCase().replace(/[^a-z ]+/g, " ").trim().split(/\s+/).at(-1) ?? "";
      return last === "email" || last === "phone" ? last : "name";
    };

    const report = await runEval(cases, async (input) => headNounOnly(input.header), [
      {
        name: "IMPORT_NO_FOREIGN_IDENTITY_RATE",
        check: (output, input: ColumnCase) =>
          !landedInIdentityColumn(output) || output === input.expected,
      },
    ]);

    expect(meetsGate(report, gatesPresentIn(report, EVAL_ACCEPTANCE))).toBe(false);
  });

  it("covers the four products this ticket names", () => {
    const products = new Set(COLUMN_MAPPING_DATASET.map((c) => c.product));
    products.delete("generic");
    expect([...products].sort()).toEqual(["hubspot", "pipedrive", "salesforce", "zoho"]);
  });

  /**
   * Every export, not just the Accounts file.
   *
   * A tenant leaving a CRM brings four files and pastes all four into the same
   * importer, and the identity traps are concentrated in the three that are not
   * Accounts — a deal's title, a person's company, an activity's organisation.
   * A dataset that drifted back to being all Accounts columns would keep its
   * numbers and stop testing most of what arrives.
   */
  it("covers each of the four exports the big four produce", () => {
    const bySource = new Map<ColumnSource, number>();
    for (const c of COLUMN_MAPPING_DATASET)
      bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);

    for (const source of ["accounts", "contacts", "deals", "activities"] as const)
      expect(bySource.get(source) ?? 0).toBeGreaterThanOrEqual(8);
  });

  it("carries the qualified headers that decide the accuracy claim", () => {
    // "Company Phone" read as a name puts every phone number in the wrong field.
    const qualified = COLUMN_MAPPING_DATASET.filter((c) =>
      /^(Company|Billing|Customer) /.test(c.header),
    );
    expect(qualified.length).toBeGreaterThanOrEqual(3);
  });
});
