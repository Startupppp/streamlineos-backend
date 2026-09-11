import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CORE = join(__dirname, "..");

/**
 * The unscoped entry read must stay off every route.
 *
 * `listEntries` applies `applyScope(..., { ownerColumn: timesheets.userId })`,
 * so someone with `own` scope sees only their own entries. `getEntryUnscoped`
 * applies nothing, and returns `billRate`, `currency`, `description` and
 * `workLink` — a colleague's commercial rate among them.
 *
 * It exists because `createEntry` and `updateEntry` hand back the row they have
 * just written, after their own guards. It was previously called
 * `getEntryById`, with a public passthrough on `EntriesService` that had no
 * caller at all — the shape that turns into a route the moment somebody needs
 * "get one entry" and finds it first.
 *
 * A CENSUS ACROSS TIMESHEETS FOUND NOTHING ELSE. Nine methods looked unscoped to
 * a scan and eight were properly guarded by mechanisms a regex cannot see:
 * `getPeriod` compares `row.userId` and throws 403, `recallPeriod` refuses
 * anything but your own, `updateEntry` resolves permissions and compares the
 * owner, `approvePeriod` delegates to `assertCanActOnPeriod`, and `reopen` and
 * `unlock` are gated on `timesheets:approvals:manage`, which is an
 * administrative key where acting on somebody else's period is the point. This
 * module has guard seams at its detail routes. That is the thing being
 * protected here.
 */

function controllers(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllers(full));
    else if (entry.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

describe("the unscoped entry read", () => {
  it("is named so its own signature warns the next caller", () => {
    const source = readFileSync(join(CORE, "entries-read.service.ts"), "utf8");
    expect(source).toContain("async getEntryUnscoped(");
    expect(source).not.toContain("async getEntryById(");
  });

  it("has exactly the two post-write callers, and no others", () => {
    const source = readFileSync(join(CORE, "entries.service.ts"), "utf8");
    const calls = source.match(/this\.reader\.getEntryUnscoped\(/g) ?? [];
    expect(calls).toHaveLength(2);
    // The public passthrough that had no caller of its own is gone; a new one
    // would put an unscoped read one decorator away from being routed.
    expect(source).not.toMatch(/^\s{2}getEntryUnscoped\(/m);
  });

  it("is not reachable from any timesheets controller", () => {
    const offenders = controllers(CORE).filter((file) =>
      /getEntryUnscoped|getEntryById/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
