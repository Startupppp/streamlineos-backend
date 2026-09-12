import fs from "node:fs";
import path from "node:path";

/**
 * Phase 3, ticket 06 — every membership insert reserves a seat first.
 *
 * The audit behind this found enforcement already in place at every path that
 * adds a member to an existing organisation. That is the good outcome, and it is
 * also the fragile one: it holds because separate call sites each remembered
 * to do it, and nothing would notice one more that did not.
 *
 * A seat limit that is not enforced is a marketing claim rather than a limit, and
 * the failure is silent -- a tenant on ten seats quietly runs fifty, and the
 * first anyone knows is the invoice conversation.
 *
 * So this reads the source. Every module path that creates a membership must
 * either reserve a seat in the same transaction, or be named below with a reason.
 *
 * The scan follows the writer. `organization_members` writes moved behind one
 * owner, `common/org/membership-mutations.ts`, so a grep for
 * `insert(organizationMembers)` under `src/modules` now finds a single file and
 * reports every other path as clean -- a scan that has stopped looking. A path
 * creates a membership if it still inserts the table directly, or if it imports
 * that owner and calls one of its creation methods. There is no third way to get
 * a membership row, because the owner is the only holder of those statements.
 *
 * The owner itself is scanned and exempt: it is the mechanical writer, and the
 * seat policy is the caller's -- `createMembership` has no idea whether it is
 * admitting the founder or the fifty-first member.
 */

const SRC = path.join(__dirname, "..", "..", "..", "..");
const ROOTS = [path.join(SRC, "modules"), path.join(SRC, "common")];
const MEMBERSHIP_MUTATIONS = path.join(SRC, "common", "org", "membership-mutations.ts");

/** The owner's creation surface. Named so the bite proof fails if one is renamed away. */
const CREATION_METHODS = [
  "createOwnerMembership",
  "createMembership",
  "createMemberships",
] as const;

/**
 * Paths that create the organisation's *first* member, plus the one mechanical writer.
 *
 * The first-member paths are exempt because there is no organisation to be over the
 * limit of: the seat count is zero and the plan is being chosen in the same breath.
 * Each is listed individually rather than matched by pattern, so adding one is a
 * deliberate act.
 */
const FIRST_MEMBER_PATHS: ReadonlyMap<string, string> = new Map([
  [
    "common/org/membership-mutations.ts",
    "the one owner of organization_members writes — it holds the statements, its callers hold the seat policy",
  ],
  [
    // bootstrapCellOrganization, the successor to organization/core/lib/organization-creation.ts.
    "modules/organization/core/bootstrap-cell-organization.ts",
    "createOrganization — the founder, before a plan exists",
  ],
]);

/** Reserving a seat is the advisory lock and the assertion, or a helper doing both. */
const RESERVES_SEAT = /reserveMemberSeat|assertWithinLimit\(\s*[\w.]+\s*,\s*["']members["']/;
const TAKES_THE_LOCK = /pg_advisory_xact_lock|reserveMemberSeat|lockMembersQuota/;

const DIRECT_INSERT = /insert\(organizationMembers\)/;
const OWNS_THE_WRITER = /membership-mutations/;
const CALLS_CREATION = new RegExp(`\\.(?:${CREATION_METHODS.join("|")})\\(`);

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith("spec.ts")) found.push(full);
  }
  return found;
}

const inserters = ROOTS.flatMap((root) => walk(root))
  .filter((file) => {
    const text = fs.readFileSync(file, "utf8");
    if (DIRECT_INSERT.test(text)) return true;
    return OWNS_THE_WRITER.test(text) && CALLS_CREATION.test(text);
  })
  .map((file) => ({ file, rel: path.relative(SRC, file).split(path.sep).join("/") }));

describe("seat enforcement", () => {
  it("finds the membership creation paths at all, so a silent zero is not a pass", () => {
    // A scan that matches nothing reports every invariant as held, so prove both halves are live:
    // the owner still declares the methods the scan follows, and both shapes were actually found.
    const owner = fs.readFileSync(MEMBERSHIP_MUTATIONS, "utf8");
    for (const method of CREATION_METHODS) expect(owner).toContain(`async ${method}(`);

    expect(
      inserters.some((entry) => DIRECT_INSERT.test(fs.readFileSync(entry.file, "utf8"))),
    ).toBe(true);
    expect(
      inserters.some((entry) => CALLS_CREATION.test(fs.readFileSync(entry.file, "utf8"))),
    ).toBe(true);
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
