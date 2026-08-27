import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { CROSS_REGION_FILES, CROSS_REGION_OPERATIONS } from "./cross-region";

/**
 * The guard behind ticket 10's enumeration.
 *
 * Before this, any of ~800 service files could call
 * `getRegionRegistry().bindingFor("eu")` and hold another region's connection,
 * and nothing anywhere would notice. The criterion the ticket asks for — "an
 * operation not on the list cannot obtain a cross-region handle" — cannot be
 * enforced by the type system, because the primitive is a plain method on a
 * module-level singleton. It can be enforced here.
 *
 * Both directions, for the same reason the legacy-reader ratchet does it: a list
 * that only grows becomes an allowlist nobody reads, and a stale entry is a file
 * somebody is free to reach for again without argument.
 */
describe("cross-region operations are enumerated", () => {
  /**
   * Naming a REGION. Resolving by org is deliberately not here — `dbForOrg`,
   * `storageForOrg` and `regionForOrg` take a tenant and can only reach that
   * tenant's own region, which is the whole point of the seam.
   */
  const NAMES_A_REGION =
    /\.bindingFor\(|withNewOrgInRegion|runInNewOrgTransaction|registry\.keys|getRegionRegistry\(\)\.keys/;

  /** Comments describe these operations constantly; only code performs one. */
  const executable = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

  function filesNamingARegion(): string[] {
    const tracked = execSync("git ls-files --cached --others --exclude-standard 'src/**/*.ts'", {
      encoding: "utf8",
    })
      .split("\n")
      .filter(
        (file) =>
          file &&
          !file.endsWith(".spec.ts") &&
          // The enumeration lists these paths as data; it performs nothing.
          file !== "src/common/region/cross-region.ts" &&
          existsSync(file),
      );

    return tracked.filter((file) => NAMES_A_REGION.test(executable(readFileSync(file, "utf8"))));
  }

  it("lets no unlisted file reach for another region", () => {
    const unlisted = filesNamingARegion().filter((file) => !CROSS_REGION_FILES.has(file));

    // Resolve by org instead -- `dbForOrg`/`storageForOrg` reach the tenant's
    // own region and cannot reach anywhere else. If naming a region really is
    // correct here, add it to CROSS_REGION_OPERATIONS with the argument for why.
    expect(unlisted).toEqual([]);
  });

  it("keeps no entry for a file that no longer reaches for one", () => {
    const actual = new Set(filesNamingARegion());
    const stale = [...CROSS_REGION_FILES].filter((file) => !actual.has(file));

    // An exemption nobody needs is one nobody is stopped from using.
    expect(stale).toEqual([]);
  });

  it("makes every permitted operation argue for itself", () => {
    const unargued = CROSS_REGION_OPERATIONS.filter(
      (operation) => operation.why.trim().length < 40,
    ).map((operation) => operation.file);

    // A one-word justification is how a list like this stops being read.
    expect(unargued).toEqual([]);
  });
});
