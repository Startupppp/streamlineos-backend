import { normaliseManagerColumns } from "./reporting-manager-columns";

describe("normaliseManagerColumns", () => {
  it("reads the canonical primary and secondary columns and reports no legacy header", () => {
    const result = normaliseManagerColumns({
      email: "new@x.com",
      primaryManagerEmail: " Boss@X.com ",
      secondaryManagerEmail2: "dotted@x.com",
    });

    expect(result).toEqual({
      ok: true,
      row: {
        email: "new@x.com",
        primaryManagerEmail: "boss@x.com",
        secondaryManagerEmail2: "dotted@x.com",
      },
      primaryManagerEmail: "boss@x.com",
      secondaryManagerEmails: [null, "dotted@x.com", null],
      legacyHeader: null,
    });
  });

  it.each(["reportingManagerEmail", "reportsTo", "managerEmail", "Reports To", "manager_email"])(
    "maps the legacy header %s to primaryManagerEmail and records that it was used",
    (header) => {
      const result = normaliseManagerColumns({ email: "new@x.com", [header]: "boss@x.com" });

      expect(result.ok && result.primaryManagerEmail).toBe("boss@x.com");
      expect(result.ok && result.legacyHeader).toBe(header);
      expect(result.ok && result.row).toEqual({ email: "new@x.com", primaryManagerEmail: "boss@x.com" });
    },
  );

  it("treats a blank cell as no value, so a blank manager means no change or fallback, never an empty email", () => {
    const result = normaliseManagerColumns({ primaryManagerEmail: "   ", secondaryManagerEmail1: "" });

    expect(result.ok && result.primaryManagerEmail).toBeNull();
    expect(result.ok && result.secondaryManagerEmails).toEqual([null, null, null]);
    expect(result.ok && result.legacyHeader).toBeNull();
  });

  it("accepts a legacy alias that repeats the canonical value and credits the canonical header", () => {
    const result = normaliseManagerColumns({ primaryManagerEmail: "boss@x.com", managerEmail: "BOSS@x.com" });

    expect(result.ok && result.primaryManagerEmail).toBe("boss@x.com");
    expect(result.ok && result.legacyHeader).toBeNull();
  });

  it("refuses a row whose manager headers disagree rather than guessing which one was meant", () => {
    const result = normaliseManagerColumns({ primaryManagerEmail: "a@x.com", reportsTo: "b@x.com" });

    expect(result).toEqual({ ok: false, conflictingColumns: ["primaryManagerEmail", "reportsTo"] });
  });

  it("leaves a non-string cell in the row so the row schema rejects it", () => {
    const result = normaliseManagerColumns({ primaryManagerEmail: 42 });

    expect(result.ok && result.row).toEqual({ primaryManagerEmail: 42 });
    expect(result.ok && result.primaryManagerEmail).toBeNull();
  });

  it("does not touch unrelated columns", () => {
    const result = normaliseManagerColumns({ email: "Keep@Case.com", department: " Ops " });

    expect(result.ok && result.row).toEqual({ email: "Keep@Case.com", department: " Ops " });
  });
});
