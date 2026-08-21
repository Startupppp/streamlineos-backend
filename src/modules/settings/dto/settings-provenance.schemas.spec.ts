import { settingsProvenanceQuerySchema } from "./settings.schemas";

describe("settingsProvenanceQuerySchema", () => {
  it("normalises a single section to an array, so the service takes one shape", () => {
    expect(settingsProvenanceQuerySchema.parse({ sections: "org" }).sections).toEqual(["org"]);
  });

  it("accepts several sections", () => {
    expect(
      settingsProvenanceQuerySchema.parse({ sections: ["org", "billing"] }).sections,
    ).toEqual(["org", "billing"]);
  });

  it("rejects an unknown section rather than running a wildcard audit scan", () => {
    expect(() => settingsProvenanceQuerySchema.parse({ sections: "payroll" })).toThrow();
    expect(() => settingsProvenanceQuerySchema.parse({ sections: ["org", "%"] })).toThrow();
  });

  it("requires sections", () => {
    expect(() => settingsProvenanceQuerySchema.parse({})).toThrow();
    expect(() => settingsProvenanceQuerySchema.parse({ sections: [] })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      settingsProvenanceQuerySchema.parse({ sections: "org", orgId: "other" }),
    ).toThrow();
  });
});
