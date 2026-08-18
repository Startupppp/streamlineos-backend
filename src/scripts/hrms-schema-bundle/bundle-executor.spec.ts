import { bundleFileNames } from "./bundle-config";
import { dependencySqlHash } from "./bundle-executor";
import type { SqlFileSnapshot } from "./bundle-files";

const files: SqlFileSnapshot[] = bundleFileNames.map((name, index) => ({
  name,
  sql: "",
  sha256: `sha-${index}`,
}));

describe("schema bundle dependency hash sequence", () => {
  it("uses no dependency for 0000", () => {
    expect(dependencySqlHash(files, bundleFileNames[0])).toBe("");
  });

  it.each([1, 2, 3, 4])(
    "binds file %i to its immediate predecessor",
    (index) => {
      const file = bundleFileNames[index];
      if (!file) throw new Error("test file is missing");
      expect(dependencySqlHash(files, file)).toBe(`sha-${index - 1}`);
    },
  );
});
