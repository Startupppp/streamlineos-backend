import { mapColumns } from "./column-mapping";
import { blockingKeysFor, planImport, type PlanInput } from "./import-plan";
import {
  assessDuplicate,
  REVIEW_THRESHOLD,
  type PartyFingerprint,
} from "../../party/party-duplicates";

const HEADERS = ["Company Name", "Email", "Phone", "GSTIN", "Territory"];
const columns = mapColumns(HEADERS);

const plan = (rows: string[][], existing: PartyFingerprint[] = []) =>
  planImport({ columns, rows, existing } as PlanInput);

const existingParty = (over: Partial<PartyFingerprint> = {}): PartyFingerprint => ({
  partyId: "p-1",
  name: "Acme Trading Ltd",
  email: "ops@acme.example",
  phone: null,
  taxNumber: null,
  website: null,
  ...over,
});

describe("planImport", () => {
  it("creates a row that is new", () => {
    const result = plan([["Globex", "hello@globex.example", "", "", ""]]);
    expect(result.rows[0]).toMatchObject({ rowNumber: 1, action: "create" });
    expect(result.summary).toMatchObject({
      create: 1,
      update: 0,
      merge: 0,
      review: 0,
      skip: 0,
      total: 1,
    });
  });

  it("reads mapped columns into fields and unknown ones into custom fields", () => {
    const result = plan([["Globex", "hello@globex.example", "+441234567890", "GST42", "North"]]);
    expect(result.rows[0]?.values).toMatchObject({
      name: "Globex",
      email: "hello@globex.example",
      taxNumber: "GST42",
    });
    // A column the user can see in their file must be findable afterwards.
    expect(result.rows[0]?.customFields).toEqual({ territory: "North" });
  });

  it("skips a row with no name, because there is nothing to create", () => {
    const result = plan([["", "orphan@example.com", "", "", ""]]);
    expect(result.rows[0]).toMatchObject({ action: "skip" });
    expect(result.rows[0]?.reason).toMatch(/no name/i);
  });

  describe("duplicates within the file", () => {
    /**
     * Checked before the database, deliberately. Checked the other way round,
     * both copies would look new and both would be created.
     */
    it("creates a repeated company once", () => {
      const result = plan([
        ["Acme Trading Ltd", "ops@acme.example", "", "", ""],
        ["Acme Trading Limited", "ops@acme.example", "", "", ""],
      ]);
      expect(result.rows[0]).toMatchObject({ action: "create" });
      expect(result.rows[1]).toMatchObject({ action: "merge", duplicateOfRow: 1 });
      expect(result.summary).toMatchObject({ create: 1, merge: 1, skip: 0 });
    });

    /**
     * The reason the repeat is a `merge` and not a `skip`. A file listing Acme
     * twice, once with the phone number and once with the tax number, describes
     * one company that has both — and reporting the second line as skipped
     * quietly dropped a column the user can see in their own file.
     */
    it("folds the repeat's values into the row it repeats", () => {
      const result = plan([
        ["Acme Trading Ltd", "ops@acme.example", "", "", "North"],
        ["Acme Trading Limited", "ops@acme.example", "+441234567890", "GST42", "South"],
      ]);

      expect(result.rows[0]?.values).toMatchObject({
        name: "Acme Trading Ltd",
        phone: "+441234567890",
        taxNumber: "GST42",
      });
      expect(result.rows[0]?.customFields).toEqual({ territory: "North" });
    });

    it("does not let a repeat overwrite what the first line already said", () => {
      // First occurrence wins, matching the rule the commit applies to an
      // existing party: a value already there is not replaced by a later one.
      const result = plan([
        ["Acme Trading Ltd", "ops@acme.example", "", "", ""],
        ["Acme Trading Limited", "ops@acme.example", "", "", ""],
      ]);
      expect(result.rows[0]?.values.name).toBe("Acme Trading Ltd");
    });

    /**
     * The fold can supply an identifier the surviving row did not have, and a
     * third occurrence may match only on that one. Blocking is by identifier, so
     * the index has to learn about it or the third line is silently created as a
     * second copy.
     */
    it("matches a third occurrence on an identifier a fold supplied", () => {
      const result = plan([
        ["Acme Trading Ltd", "ops@acme.example", "", "", ""],
        ["Acme Trading Limited", "ops@acme.example", "", "GST42", ""],
        ["Acme Trading Co", "", "", "GST42", ""],
      ]);

      expect(result.rows[2]).toMatchObject({ action: "merge", duplicateOfRow: 1 });
      expect(result.summary.create).toBe(1);
    });

    it("does not treat two different companies as one", () => {
      const result = plan([
        ["Acme Trading", "ops@acme.example", "", "", ""],
        ["Globex Industries", "hello@globex.example", "", "", ""],
      ]);
      expect(result.summary.create).toBe(2);
    });
  });

  describe("against what already exists", () => {
    it("updates a row that plainly matches an existing party", () => {
      const result = plan(
        [["Acme Trading Ltd", "ops@acme.example", "+441234567890", "", ""]],
        [existingParty()],
      );
      expect(result.rows[0]).toMatchObject({ action: "update", matchedRecordId: "p-1" });
    });

    /**
     * Between the two thresholds nothing is written at all.
     *
     * Phase 1 created a second record here and left the duplicate queue to catch
     * it afterwards. An import performs that speculative write at scale — a file
     * of near-matches silently doubles a customer list, and the person who
     * approved the preview was told "created separately for review" in a row
     * sample they did not read.
     */
    it("holds a row for review when it is only fairly sure", () => {
      // A shared phone and a close-but-different name: enough to be worth a
      // look, nowhere near enough to fuse two companies' histories.
      const result = plan(
        [["Acme Trading", "", "+441234567890", "", ""]],
        [existingParty({ name: "Acme Trading Group", email: null, phone: "+441234567890" })],
      );
      expect(result.rows[0]?.action).toBe("review");
      expect(result.rows[0]?.matchedRecordId).toBe("p-1");
      expect(result.rows[0]?.reason).toMatch(/not close enough/i);
      expect(result.summary).toMatchObject({ create: 0, review: 1 });
    });

    /**
     * The finding the held row files needs the score and the signals, and
     * re-deriving them at commit time against a table that has moved on would
     * let the commit disagree with the preview the tenant approved.
     */
    it("records what the scorer saw on the row it was unsure about", () => {
      const result = plan(
        [["Acme Trading", "", "+441234567890", "", ""]],
        [existingParty({ name: "Acme Trading Group", email: null, phone: "+441234567890" })],
      );

      expect(result.rows[0]?.match).toMatchObject({
        signals: expect.arrayContaining(["phone"]),
        candidateName: "Acme Trading Group",
      });
      expect(result.rows[0]?.match?.score).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    });

    it("never matches across a contradiction", () => {
      // Two different registration numbers are proof these are different
      // entities, however alike the names read.
      const result = plan(
        [["Acme Trading Ltd", "ops@acme.example", "", "GST-999", ""]],
        [existingParty({ taxNumber: "GST-111" })],
      );
      expect(result.rows[0]?.action).toBe("create");
    });
  });

  describe("what the preview promises", () => {
    /**
     * The criterion is that the committed result matches the preview. The only
     * way to guarantee that is one plan, computed once — so planning twice over
     * the same input must be identical.
     */
    it("is deterministic", () => {
      const rows = [
        ["Acme Trading Ltd", "ops@acme.example", "", "", "North"],
        ["", "", "", "", ""],
        ["Globex", "hello@globex.example", "", "", "South"],
        ["Acme Trading Limited", "ops@acme.example", "", "", ""],
      ];
      expect(plan(rows, [existingParty({ partyId: "p-9", name: "Zenith" })])).toEqual(
        plan(rows, [existingParty({ partyId: "p-9", name: "Zenith" })]),
      );
    });

    it("counts every row exactly once", () => {
      const result = plan([
        ["Acme Trading Ltd", "ops@acme.example", "", "", ""],
        ["", "", "", "", ""],
        ["Globex", "", "", "", ""],
        ["Acme Trading Limited", "ops@acme.example", "", "", ""],
      ]);
      const { create, update, merge, review, skip, total } = result.summary;
      expect(create + update + merge + review + skip).toBe(total);
      expect(total).toBe(4);
    });
  });

  /**
   * `partyType` is an enum column, so the file's spelling of it has to become
   * one of the enum's values while the row is READ — the preview shows what
   * the commit will write, and a coercion only the commit knew about would put
   * the divergence back.
   */
  describe("fields with a shape of their own", () => {
    const typed = mapColumns(["Company Name", "Type", "Status"]);
    const readTyped = (cells: string[]) =>
      planImport({ columns: typed, rows: [cells], existing: [] }).rows[0];

    it("reads what another product calls a party type", () => {
      expect(readTyped(["Acme", "Supplier", ""])?.values).toMatchObject({ partyType: "VENDOR" });
      expect(readTyped(["Acme", "vendor", ""])?.values).toMatchObject({ partyType: "VENDOR" });
      expect(readTyped(["Acme", "Customer & Vendor", ""])?.values).toMatchObject({
        partyType: "BOTH",
      });
    });

    it("does not guess at a word it does not know", () => {
      const row = readTyped(["Acme", "Enterprise", ""]);
      expect(row?.values.partyType).toBeUndefined();
      // Nor does it drop the cell: a column the user can see in their file and
      // cannot find afterwards is data loss they discover months later.
      expect(row?.customFields).toMatchObject({ type: "Enterprise" });
    });

    it("passes a status through, because the column is free text", () => {
      expect(readTyped(["Acme", "", "prospect"])?.values).toMatchObject({ status: "prospect" });
    });
  });

  /**
   * Candidates are fetched by identifier rather than as an arbitrary slice of
   * the tenant, and these four keys are enough because of the weights in
   * `party-duplicates` — which is an assumption worth a test of its own.
   */
  describe("the identifiers a file could match on", () => {
    it("normalises the file's spelling, the way a comparison would", () => {
      const keys = blockingKeysFor(columns, [
        ["Acme", "OPS@Acme.Example", "+44 (0)1234 567890", "gst-42", ""],
      ]);

      expect(keys.emails).toEqual(["ops@acme.example"]);
      expect(keys.phones).toEqual(["1234567890"]);
      expect(keys.taxNumbers).toEqual(["GST42"]);
    });

    it("collects nothing from a file with no identifier in it", () => {
      expect(blockingKeysFor(columns, [["Acme", "", "", "", "North"]])).toEqual({
        taxNumbers: [],
        emails: [],
        phones: [],
        hosts: [],
      });
    });

    it("cannot miss a match, because a name alone never reaches the threshold", () => {
      // The best a pair can do while sharing none of those four: an identical
      // name and a shared e-mail domain. If a weight ever changes so that this
      // reaches the review threshold, fetching by identifier starts missing
      // duplicates silently — so it is pinned here rather than assumed.
      const best = assessDuplicate(
        {
          partyId: "a",
          name: "Acme Trading",
          email: "one@acme.example",
          phone: null,
          taxNumber: null,
          website: null,
        },
        {
          partyId: "b",
          name: "Acme Trading",
          email: "two@acme.example",
          phone: null,
          taxNumber: null,
          website: null,
        },
      );

      expect(best.score).toBeLessThan(REVIEW_THRESHOLD);
    });
  });

  it("contributes nothing from a column nobody answered for", () => {
    // An unanswered question must not quietly become an answer.
    const ambiguous = mapColumns(["Company", "Account Name"]);
    const result = planImport({
      columns: ambiguous,
      rows: [["Acme", "Something Else"]],
      existing: [],
    });
    expect(result.rows[0]?.values).toEqual({ name: "Acme" });
  });
});

/**
 * The preview is the ceiling now that the commit is durable and chunked, and
 * comparing every row against every row is what makes it one — five thousand
 * rows is twelve million scorings before anything is written. Blocking removes
 * that, and these pin the argument that it is sound rather than merely fast.
 */
describe("comparing a large file without comparing everything twice", () => {
  const many = (count: number): string[][] =>
    Array.from({ length: count }, (_, index) => [
      `Company ${String(index)}`,
      `contact${String(index)}@example-${String(index)}.test`,
      "",
      `GST${String(index)}`,
      "",
    ]);

  it("plans a file of five thousand distinct companies", () => {
    const started = Date.now();
    const result = plan(many(5_000));
    // A generous bound: the point is that it is linear, not that it is fast on
    // any particular machine. The quadratic version does not finish near this.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.summary.create).toBe(5_000);
  });

  it("still finds the repeat buried in a large file", () => {
    const rows = many(2_000);
    rows.push(["Company 3", "contact3@example-3.test", "", "GST3", ""]);

    const result = plan(rows);
    expect(result.rows.at(-1)).toMatchObject({ action: "merge", duplicateOfRow: 4 });
  });
});
