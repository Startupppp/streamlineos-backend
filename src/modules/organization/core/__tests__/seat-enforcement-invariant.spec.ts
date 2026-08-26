import fs from "node:fs";
import path from "node:path";

/**
 * Phase 3, ticket 06 — every membership insert reserves a seat first.
 *
 * The audit behind this found enforcement already in place at every path that
 * adds a member to an existing organisation. That is the good outcome, and it is
 * also the fragile one: it holds because six separate call sites each remembered
 * to do it, and nothing would notice a seventh that did not.
 *
 * A seat limit that is not enforced is a marketing claim rather than a limit, and
 * the failure is silent -- a tenant on ten seats quietly runs fifty, and the
 * first anyone knows is the invoice conversation.
 *
 * So this reads the source. Every `insert(organizationMembers)` in a module must
 * either reserve a seat in the same transaction, or be named below with a reason.
 */

const MODULES = path.join(__dirname, "..", "..", "..");

/**
 * Paths that create the organisation's *first* member.
 *
 * Exempt because there is no organisation to be over the limit of: the seat count
 * is zero and the plan is being chosen in the same breath. Each is listed
 * individually rather than matched by pattern, so adding one is a deliberate act.
 */
const FIRST_MEMBER_PATHS: ReadonlyMap<string, string> = new Map([
  [
    "organization/core/org-profile.service.ts",
    "createOrganization — the founder, before a plan exists",
  ],
  [
    "organization/setup/org-setup.service.ts",
    "org setup — the founder again, on the setup path",
  ],
  [
    "auth/auth.service.ts",
    "registration — creates the organisation and its first member together",
  ],
]);

/** Reserving a seat is the advisory lock and the assertion, or a helper doing both. */
const RESERVES_SEAT = /reserveMemberSeat|assertWithinLimit\(\s*\w+\s*,\s*["']members["']/;
const TAKES_THE_LOCK = /pg_advisory_xact_lock|reserveMemberSeat/;

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith("spec.ts")) found.push(full);
  }
  return found;
}

const inserters = walk(MODULES)
  .filter((file) => fs.readFileSync(file, "utf8").includes("insert(organizationMembers)"))
  .map((file) => ({ file, rel: path.relative(MODULES, file).split(path.sep).join("/") }));

describe("seat enforcement", () => {
  it("finds the membership insert paths at all, so a silent zero is not a pass", () => {
    // A scan that matches nothing reports every invariant as held.
    expect(inserters.length).toBeGreaterThanOrEqual(4);
  });

  it("reserves a seat before every membership insert", () => {
    const unguarded = inserters
      .filter((entry) => !FIRST_MEMBER_PATHS.has(entry.rel))
      .filter((entry) => !RESERVES_SEAT.test(fs.readFileSync(entry.file, "utf8")))
      .map(
        (entry) =>
          `${entry.rel} — inserts into organization_members without asserting the ` +
          `members limit. Reserve the seat in the same transaction as the insert, or ` +
          `add the path to FIRST_MEMBER_PATHS with a reason.`,
      );

    expect(unguarded).toEqual([]);
  });

  it("serialises every seat check against a concurrent one", () => {
    // Without the per-organisation advisory lock, two requests both read a count
    // of nine against a limit of ten and both insert. The assertion passes twice
    // and the tenant ends up with eleven seats.
    const unserialised = inserters
      .filter((entry) => !FIRST_MEMBER_PATHS.has(entry.rel))
      .filter((entry) => !TAKES_THE_LOCK.test(fs.readFileSync(entry.file, "utf8")))
      .map(
        (entry) =>
          `${entry.rel} — asserts the seat limit without taking the ` +
          `quota:<org>:members advisory lock, so two concurrent adds can both pass it.`,
      );

    expect(unserialised).toEqual([]);
  });

  it("keeps the exemption list to paths that genuinely create the first member", () => {
    // An exemption is a hole with a note on it; this stops the note becoming the
    // habit. Each entry carries a reason, and the list stays short.
    for (const [rel, reason] of FIRST_MEMBER_PATHS) {
      expect(reason.length).toBeGreaterThan(20);
      expect(inserters.some((entry) => entry.rel === rel)).toBe(true);
    }
    expect(FIRST_MEMBER_PATHS.size).toBeLessThanOrEqual(4);
  });
});
