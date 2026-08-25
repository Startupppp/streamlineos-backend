import { parseOptions } from "./backfill-kb-pages";

describe("backfill-kb-pages operator options", () => {
  it("does not authorize writes by default", () => {
    expect(parseOptions([]).apply).toBe(false);
  });

  it("requires an explicit apply flag while retaining operational bounds", () => {
    expect(
      parseOptions([
        "--apply",
        "--org-id=org-1",
        "--max-pages=25",
        "--batch-size",
        "5",
        "--delay-ms=200",
      ]),
    ).toEqual({
      apply: true,
      orgId: "org-1",
      maxPages: 25,
      batchSize: 5,
      delayMs: 200,
      afterPageId: undefined,
    });
  });
});
