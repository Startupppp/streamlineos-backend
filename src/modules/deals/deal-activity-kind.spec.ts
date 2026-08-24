import { activityKindFor, isActivityKind, NOT_AN_ACTIVITY, subjectFor } from "./deal-activity-kind";

describe("activityKindFor", () => {
  it("maps every type the deal DTO accepts", () => {
    // The DTO enum is ["call","email","meeting","note","document"]; if one of
    // these stopped mapping, logging it would silently write nothing.
    for (const legacy of ["call", "email", "meeting", "note", "document"])
      expect(activityKindFor(legacy)).not.toBeNull();
  });

  it("sends a document to note rather than inventing a sixth kind", () => {
    expect(activityKindFor("document")).toBe("note");
  });

  it("refuses a stage change, which the transition ledger owns", () => {
    expect(activityKindFor("stage_change")).toBeNull();
    expect(NOT_AN_ACTIVITY.has("stage_change")).toBe(true);
  });

  it("tolerates the casing and padding a legacy row may carry", () => {
    expect(activityKindFor(" CALL ")).toBe("call");
    expect(activityKindFor("Stage_Change")).toBeNull();
  });

  it("returns null for a type nothing declares, rather than guessing", () => {
    expect(activityKindFor("smoke-signal")).toBeNull();
    expect(activityKindFor("")).toBeNull();
  });

  it("only ever returns a kind the unified table accepts", () => {
    for (const legacy of ["call", "email", "meeting", "note", "task", "document"]) {
      const kind = activityKindFor(legacy);
      expect(kind && isActivityKind(kind)).toBe(true);
    }
  });
});

describe("subjectFor", () => {
  it("keeps the subject a person typed", () => {
    expect(subjectFor("document", "Signed MSA")).toBe("Signed MSA");
  });

  it("labels an untitled document, so the timeline is not a blank note", () => {
    expect(subjectFor("document", null)).toBe("Document");
    expect(subjectFor("document", "   ")).toBe("Document");
  });

  it("leaves other kinds unlabelled, because their own kind already says it", () => {
    expect(subjectFor("call", null)).toBeNull();
  });
});
