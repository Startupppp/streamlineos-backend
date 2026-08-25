import { mapColumns } from "./column-mapping";
import { planImport, type PlanInput } from "./import-plan";
import type { PartyFingerprint } from "../party/party-duplicates";

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
    expect(result.summary).toMatchObject({ create: 1, update: 0, skip: 0, total: 1 });
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
      expect(result.rows[1]).toMatchObject({ action: "skip", duplicateOfRow: 1 });
      expect(result.summary).toMatchObject({ create: 1, skip: 1 });
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
      expect(result.rows[0]).toMatchObject({ action: "update", matchedPartyId: "p-1" });
    });

    /**
     * The expensive mistake is merging two companies' histories, which a later
     * reversal cannot cleanly separate. Creating a second record is the cheap
     * one, and the duplicate queue already exists to catch it.
     */
    it("creates rather than merges when it is only fairly sure", () => {
      // A shared phone and a close-but-different name: enough to be worth a
      // look, nowhere near enough to fuse two companies' histories.
      const result = plan(
        [["Acme Trading", "", "+441234567890", "", ""]],
        [existingParty({ name: "Acme Trading Group", email: null, phone: "+441234567890" })],
      );
      expect(result.rows[0]?.action).toBe("create");
      expect(result.rows[0]?.reason).toMatch(/not close enough/i);
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
      const { create, update, skip, total } = result.summary;
      expect(create + update + skip).toBe(total);
      expect(total).toBe(4);
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
