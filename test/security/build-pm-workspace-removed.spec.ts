import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const BACKEND_ROOT = resolve(__dirname, "..", "..");
const SELF = relative(BACKEND_ROOT, __filename).replace(/\\/g, "/").replace(/\.js$/, ".ts");

const FILES_THAT_MUST_QUOTE_THE_RETIRED_NAME_TO_PROVE_ITS_ABSENCE = new Set([
  "src/db/schema/phase-2/migration-1141-1142-preflight.spec.ts",
  "src/scripts/check-migration-discipline.mjs",
  "src/modules/build/core/build-no-pm-workspace-invariant.spec.ts",
  "src/modules/build/managed-products/managed-products-insights-chain.spec.ts",
  "src/modules/build/teams/team-members.isolation.spec.ts",
]);

const SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "migrations") continue;
      walk(full, out);
    } else if (SCAN_EXTENSIONS.some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const ALL_FILES = [
  ...walk(resolve(BACKEND_ROOT, "src")),
  ...walk(resolve(BACKEND_ROOT, "test")),
].map((file) => relative(BACKEND_ROOT, file).replace(/\\/g, "/"));

const SCANNED_FILES = ALL_FILES.filter(
  (path) =>
    path !== SELF &&
    !FILES_THAT_MUST_QUOTE_THE_RETIRED_NAME_TO_PROVE_ITS_ABSENCE.has(path),
);

const BANNED_IDENTIFIERS = [
  /\bpmWorkspaceId\b/,
  /\bpmWorkspaceMemberships\b/,
  /\bpmWorkspaces\b/,
];

const BANNED_STRINGS = ["pm_workspace_id", "build:workspaces:", "Default Workspace"];

function violationsIn(path: string): string[] {
  const content = readFileSync(join(BACKEND_ROOT, path), "utf8");
  const hits: string[] = [];
  for (const pattern of BANNED_IDENTIFIERS) if (pattern.test(content)) hits.push(pattern.source);
  for (const needle of BANNED_STRINGS) if (content.includes(needle)) hits.push(needle);
  return hits;
}

describe("Build PM workspace removal — the concept must not grow back under src/ or test/", () => {
  it("the scanner is not vacuous: every file it is told to skip really does contain the retired name", () => {
    for (const path of FILES_THAT_MUST_QUOTE_THE_RETIRED_NAME_TO_PROVE_ITS_ABSENCE) {
      expect(violationsIn(path).length).toBeGreaterThan(0);
    }
  });

  it("walked at least the files this spec and the intake/timesheets specs live in (the walk reaches real content)", () => {
    expect(ALL_FILES).toContain("src/modules/access/entitlements.service.ts");
    expect(ALL_FILES).toContain("test/helpers/seed-builder.ts");
  });

  it("no identifier or string for the removed pm-workspace concept appears outside migrations and the files that legitimately quote it to prove its absence", () => {
    const offenders: Record<string, string[]> = {};
    for (const path of SCANNED_FILES) {
      const hits = violationsIn(path);
      if (hits.length > 0) offenders[path] = hits;
    }
    expect(offenders).toEqual({});
  });
});
