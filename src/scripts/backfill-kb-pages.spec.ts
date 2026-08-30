import { parseOptions, validateApplyOptions } from "./backfill-kb-pages";

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

  it("rejects an apply request without a tenant and finite bounds", () => {
    expect(validateApplyOptions(parseOptions(["--apply"]))).toBe(
      "--org-id is required with --apply",
    );
    expect(
      validateApplyOptions(parseOptions(["--apply", "--org-id=org-1"])),
    ).toContain("--max-pages");
  });

  it("accepts only an explicitly bounded apply request", () => {
    expect(
      validateApplyOptions(
        parseOptions([
          "--apply",
          "--org-id=org-1",
          "--max-pages=1",
          "--batch-size=1",
          "--delay-ms=100",
        ]),
      ),
    ).toBeUndefined();
  });
});
