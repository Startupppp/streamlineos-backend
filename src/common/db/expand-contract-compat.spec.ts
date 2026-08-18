import { resolveCompatibleList } from "./expand-contract-compat";

describe("resolveCompatibleList", () => {
  it("uses reconciled normalized values without changing list order", () => {
    const legacyTags = ["tax", "approved"];

    expect(resolveCompatibleList(legacyTags, ["tax", "approved"])).toEqual(
      legacyTags,
    );
  });

  it("keeps legacy values when normalized rows are incomplete or reordered", () => {
    const legacyReasons = ["policy", "conduct"];

    expect(resolveCompatibleList(legacyReasons, ["policy"])).toEqual(
      legacyReasons,
    );
    expect(resolveCompatibleList(legacyReasons, ["conduct", "policy"])).toEqual(
      legacyReasons,
    );
  });

  it("supports structural equality for schemaless per-record payloads", () => {
    const legacyRecords = [{ outcome: "closed", severity: 2 }];
    const normalizedRecords = [{ outcome: "closed", severity: 2 }];

    expect(
      resolveCompatibleList(
        legacyRecords,
        normalizedRecords,
        (legacyRecord, normalizedRecord) =>
          JSON.stringify(legacyRecord) === JSON.stringify(normalizedRecord),
      ),
    ).toEqual(normalizedRecords);
  });
});
