import { AUTO_MERGE_THRESHOLD, REVIEW_THRESHOLD } from "../party/party-duplicates";
import { rowIdentityKey, uncertaintyFinding } from "./import-uncertainty";

const held = (over: Partial<Parameters<typeof uncertaintyFinding>[0]> = {}) =>
  uncertaintyFinding({
    crmImportId: "import-1",
    rowNumber: 7,
    matchedPartyId: "party-9",
    match: { score: 0.55, signals: ["phone", "name-close"], candidateName: "Acme Trading Ltd" },
    values: { name: "Acme Trading", phone: "+44 1234 567890" },
    reason: "Looks like something you already have.",
    sourceFilename: "zoho-accounts.csv",
    ...over,
  });

describe("uncertaintyFinding", () => {
  it("files against the producer ticket 16 left waiting", () => {
    expect(held()).toMatchObject({
      producer: "import-uncertainty",
      findingKind: "import-uncertainty.near-duplicate",
      partyId: "party-9",
    });
  });

  /**
   * The queue's own rule, and the one the grouped view is a single `GROUP BY`
   * because of. Severity varying inside a group would ask a person the same
   * question at three severities.
   */
  it("puts the band inside the group key, so one group is one severity", () => {
    const byGroup = new Map<string, Set<string>>();

    for (const score of [0.46, 0.55, 0.6, 0.65, 0.7, 0.8, 0.84]) {
      const finding = held({ match: { score, signals: ["phone"] } });
      const severities = byGroup.get(finding.groupKey) ?? new Set<string>();
      severities.add(finding.severity);
      byGroup.set(finding.groupKey, severities);
    }

    for (const severities of byGroup.values()) expect(severities.size).toBe(1);
  });

  /**
   * The bands come from `producer-bands`, which reads them off the detector's
   * own thresholds. A second set of numbers here would let the queue and the
   * importer disagree about the same pair of records.
   */
  it("bands on the same thresholds that put the row under review", () => {
    const low = held({ match: { score: REVIEW_THRESHOLD, signals: ["phone"] } });
    const high = held({ match: { score: AUTO_MERGE_THRESHOLD - 0.001, signals: ["phone"] } });

    expect(low.severity).toBe("low");
    expect(high.severity).toBe("medium");
  });

  /**
   * There is no second party to merge — the whole point of holding the row is
   * that nothing was written for it — so proposing a merge would put a button
   * under a decision the queue cannot execute.
   */
  it("proposes nothing, and takes its reversibility from that", () => {
    expect(held()).toMatchObject({ proposedAction: "none", reversibility: "instant" });
  });

  it("carries enough for a person to judge the row without re-running the import", () => {
    expect(held().evidence).toMatchObject({
      crmImportId: "import-1",
      rowNumber: 7,
      sourceFilename: "zoho-accounts.csv",
      candidateName: "Acme Trading Ltd",
      signals: ["phone", "name-close"],
      values: { name: "Acme Trading" },
    });
  });

  /**
   * Upload, look at the mess, fix the spreadsheet, upload again — which is what
   * an evaluation actually looks like. Keyed on the import or the row number,
   * the second upload would file a second copy of a question nobody has answered
   * yet.
   */
  it("is the same subject when the same row is imported again", () => {
    const first = held({ crmImportId: "import-1", rowNumber: 7 });
    const again = held({ crmImportId: "import-2", rowNumber: 41 });

    expect(again.subjectKey).toBe(first.subjectKey);
  });

  it("is a different subject for a different candidate", () => {
    expect(held({ matchedPartyId: "party-other" }).subjectKey).not.toBe(held().subjectKey);
  });
});

describe("rowIdentityKey", () => {
  it("prefers the strongest identifier the row carries", () => {
    expect(rowIdentityKey({ name: "Acme", taxNumber: "gst-42", email: "a@b.example" })).toBe(
      "t:GST42",
    );
    expect(rowIdentityKey({ name: "Acme", email: "Ops@Acme.Example" })).toBe("e:ops@acme.example");
    expect(rowIdentityKey({ name: "Acme", phone: "+44 (0)1234 567890" })).toBe("p:1234567890");
    expect(rowIdentityKey({ name: "Acme", website: "https://www.acme.example/about" })).toBe(
      "h:acme.example",
    );
  });

  it("normalises the same way the scorer does, so one address is one subject", () => {
    expect(rowIdentityKey({ name: "Acme", taxNumber: "GST 42" })).toBe(
      rowIdentityKey({ name: "Acme", taxNumber: "gst-42" }),
    );
  });

  it("falls back to the name, which is all a row with no identifier can have", () => {
    // Nothing else could have carried it past the review threshold anyway.
    expect(rowIdentityKey({ name: "Acme Trading Ltd" })).toBe("n:acme trading");
  });
});
