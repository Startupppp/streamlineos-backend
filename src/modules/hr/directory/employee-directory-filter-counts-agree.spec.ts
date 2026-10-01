import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptedCondition, pendingCondition } from "./employees.service";

const SOURCE = readFileSync(
  join(process.cwd(), "src/modules/hr/directory/employees.service.ts"),
  "utf8",
);

function sqlText(value: { queryChunks?: unknown[] }): string {
  return (value.queryChunks ?? [])
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const record = chunk as { value?: unknown; name?: unknown };
      if (Array.isArray(record.value)) return record.value.join("");
      if (typeof record.name === "string") return record.name;
      return "";
    })
    .join("");
}

function filterArm(name: string): string {
  const start = SOURCE.indexOf("private async directoryConditions(");
  const body = SOURCE.slice(start, SOURCE.indexOf("private async getEmployeeCounts("));
  const line = body
    .split("\n")
    .find((candidate) => candidate.includes(`isActive === "${name}"`));
  if (line === undefined) throw new Error(`no filter arm for ${name}`);
  return line;
}

describe("HRMS-A-001 the directory's status filter and its status counters agree", () => {
  it("filters Active on the same predicate the active counter counts", () => {
    expect(filterArm("true")).toContain("acceptedCondition()");
    expect(SOURCE).toContain("active: sql<number>`count(*) filter (where ${acceptedCondition()})`");
  });

  it("does not filter Active on the bare account flag, which is true before an invite is opened", () => {
    expect(filterArm("true")).not.toContain("eq(users.isActive, true)");
  });

  it("filters Pending on the same predicate the pending counter counts", () => {
    expect(filterArm("pending")).toContain("pendingCondition()");
    expect(SOURCE).toContain("pending: sql<number>`count(*) filter (where ${pendingCondition()})`");
  });

  it("filters Inactive on the same predicate the inactive counter counts", () => {
    expect(filterArm("false")).toContain("eq(users.isActive, false)");
    expect(SOURCE).toContain("inactive: sql<number>`count(*) filter (where not ${users.isActive})`");
  });
});

describe("the three buckets partition the directory, so no row is counted twice or lost", () => {
  const accepted = sqlText(acceptedCondition());
  const pending = sqlText(pendingCondition());

  it("separates accepted from pending on whether the invite was ever opened", () => {
    expect(accepted).toContain("is not null");
    expect(pending).toContain("is null");
  });

  it("requires the account flag on both of the active-side buckets", () => {
    expect(accepted).toMatch(/is_active/);
    expect(pending).toMatch(/is_active/);
  });

  it("reads acceptance from email_verified on both, so neither can drift to another column", () => {
    expect(accepted).toMatch(/email_verified/);
    expect(pending).toMatch(/email_verified/);
  });

  it("keeps the counters and the filter on one pair of exported predicates rather than two spellings", () => {
    const inlineAccepted = SOURCE.match(/and \$\{users\.emailVerified\} is not null/g) ?? [];

    expect(inlineAccepted).toHaveLength(1);
    expect(SOURCE).toContain("export function acceptedCondition()");
    expect(SOURCE).toContain("export function pendingCondition()");
  });
});
