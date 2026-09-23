import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SELF_PATH = __filename;

const SCAN_ROOTS = [
  join(__dirname, ".."),
  join(__dirname, "../../../db/schema/build"),
];

const FORBIDDEN: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "pmWorkspaceId", pattern: /\bpmWorkspaceId\b/ },
  { label: "pmWorkspaces", pattern: /\bpmWorkspaces\b/ },
  { label: "pmWorkspaceMemberships", pattern: /\bpmWorkspaceMemberships\b/ },
  { label: "pm_workspace_id", pattern: /pm_workspace_id/ },
  { label: "build:workspaces:", pattern: /build:workspaces:/ },
  { label: "Default Workspace", pattern: /Default Workspace/ },
];

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      files.push(full);
    }
  }
}

const REMOVAL_PROOF_SPECS = [
  join(__dirname, "../teams/team-members.isolation.spec.ts"),
  join(__dirname, "../managed-products/managed-products-insights-chain.spec.ts"),
];

function collectBuildSourceFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  return files
    .filter((f) => f !== SELF_PATH)
    .filter((f) => !REMOVAL_PROOF_SPECS.includes(f));
}

describe("PM Workspace was removed from Build — none of its identifiers may reappear under src/modules/build or src/db/schema/build", () => {
  const files = collectBuildSourceFiles();

  it("scans a non-trivial slice of the Build tree, so a passing run cannot be a vacuous empty scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const { label, pattern } of FORBIDDEN) {
    it(`no Build source file reintroduces the retired identifier/string "${label}"`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        if (pattern.test(content)) offenders.push(relative(process.cwd(), file));
      }
      expect(offenders).toEqual([]);
    });
  }

  it.each(REMOVAL_PROOF_SPECS)(
    "%s is exempt from the scan only because it asserts the retired name is gone — so it must still quote that name",
    (specPath) => {
      const content = readFileSync(specPath, "utf8");
      expect(/pm_workspace_id|pmWorkspaceId/.test(content)).toBe(true);
      expect(/\bnot\b/.test(content)).toBe(true);
    },
  );
});
