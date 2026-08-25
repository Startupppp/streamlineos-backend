import { parseConversionOptions } from "./convert-kb-articles";

describe("convert-kb-articles operator options", () => {
  it("is read-only unless --apply is explicit", () => {
    expect(parseConversionOptions([])).toEqual({
      apply: false,
      orgId: undefined,
      userId: undefined,
      confirmation: undefined,
    });
  });

  it("parses a fully scoped apply request", () => {
    expect(
      parseConversionOptions([
        "--apply",
        "--org-id=org-1",
        "--user-id",
        "user-1",
        "--confirmation=CONVERT_PUBLISHED_ARTICLES",
      ]),
    ).toEqual({
      apply: true,
      orgId: "org-1",
      userId: "user-1",
      confirmation: "CONVERT_PUBLISHED_ARTICLES",
    });
  });
});
