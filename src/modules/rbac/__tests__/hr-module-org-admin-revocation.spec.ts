import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import { UsersController } from "../../users/users.controller";
import { ALL_PERMISSION_NAMES } from "../permissions";
import { ROLE_TEMPLATES } from "../role-templates.constants";
import { buildDesiredGrants } from "../role-grant-reconciler.service";
import {
  buildModuleAdminPermissionKeys,
  buildModuleMemberPermissionKeys,
  buildOrgAdminPermissionKeys,
  systemRoleSpecs,
} from "../seed-system-roles";

/**
 * `settings:organization:manage` gates organisation membership administration — POST /users,
 * POST /users/invite, POST /users/bulk-invite and the invitation and member lifecycle routes.
 * `MODULE_ADMIN_EXTRA_KEYS.hr` handed it to HR_MODULE_ADMIN and HR_MODULE_OWNER, so an HR *module*
 * administrator held *organisation* administration in every organisation, and
 * `RoleGrantReconcilerService` re-delivered it to every pristine rung at each boot.
 *
 * The template is the forward repair; migration 1094 is the withdrawal for organisations that
 * already hold the grant. Both halves are asserted here, because either alone leaves the defect
 * live somewhere.
 */
const MEMBERSHIP_ADMIN_KEY = "settings:organization:manage";
const HR_RUNGS = ["HR_MODULE_ADMIN", "HR_MODULE_OWNER"] as const;
const MIGRATION_TAG = "1109_hr_module_roles_drop_org_membership_admin";

const CATALOG = new Set(ALL_PERMISSION_NAMES);
const MIGRATIONS_DIR = join(__dirname, "../../../../migrations");

function usersGate(method: keyof UsersController): string | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION, UsersController.prototype[method]);
}

function readMigration(relativePath: string): string {
  const path = join(MIGRATIONS_DIR, relativePath);
  if (!existsSync(path))
    throw new Error(`missing migration file ${relativePath} — this suite would pass vacuously`);
  return readFileSync(path, "utf8");
}

// Split on /\r?\n/: `.` does not match `\r`, so `--.*$` leaves every comment intact on a CRLF file.
function executableSql(relativePath: string): string {
  return readMigration(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** Every slug literal in a `slug = '…'` or `slug IN ('…', '…')` predicate, deduplicated. */
function slugsNamedIn(sql: string): string[] {
  const predicates = [...sql.matchAll(/"?slug"?\s*(?:=|IN)\s*(\([^)]*\)|'[A-Z0-9_]+')/gi)];
  const slugs = predicates.flatMap((match) =>
    [...match[1].matchAll(/'([A-Z0-9_]+)'/g)].map((inner) => inner[1]),
  );
  return [...new Set(slugs)];
}

describe("HR module rungs do not hold organisation membership administration", () => {
  it("the HR module admin rung no longer carries the key", () => {
    expect(buildModuleAdminPermissionKeys("hr", CATALOG)).not.toContain(MEMBERSHIP_ADMIN_KEY);
  });

  it("keeps every legitimate HR key on that rung — the repair removed one key, not a role", () => {
    const keys = buildModuleAdminPermissionKeys("hr", CATALOG);

    expect(keys).toContain("settings:view");
    expect(keys).toContain("hr:employees:view");
    expect(keys).toContain("hr:employees:manage");
    expect(keys).toContain("hr:access:view");
    expect(keys).toContain("hr:access:manage");
    expect(keys.filter((key) => key.startsWith("hr:")).length).toBeGreaterThan(50);
  });

  it("leaves the HR module member rung as it was", () => {
    const keys = buildModuleMemberPermissionKeys("hr", CATALOG);

    expect(keys).toContain("settings:view");
    expect(keys).not.toContain(MEMBERSHIP_ADMIN_KEY);
  });

  it.each(HR_RUNGS)("the seeded %s spec does not grant it", (slug) => {
    const spec = systemRoleSpecs(CATALOG).find((candidate) => candidate.slug === slug);

    expect(spec).toBeDefined();
    expect(spec?.permissionKeys).not.toContain(MEMBERSHIP_ADMIN_KEY);
  });

  it("no module-scoped seeded rung in any module holds it", () => {
    const offenders = systemRoleSpecs(CATALOG)
      .filter((spec) => spec.moduleKey !== null)
      .filter((spec) => spec.permissionKeys.includes(MEMBERSHIP_ADMIN_KEY))
      .map((spec) => spec.slug);

    expect(offenders).toEqual([]);
  });

  it("no role template carries it either", () => {
    const offenders = ROLE_TEMPLATES.filter((template) =>
      template.permissions.includes(MEMBERSHIP_ADMIN_KEY),
    ).map((template) => template.slug);

    expect(offenders).toEqual([]);
  });
});

describe("a module-only administrator is denied organisation member administration", () => {
  const hrAdminRung = new Set(buildModuleAdminPermissionKeys("hr", CATALOG));

  it.each([
    ["POST /users", "createUser"],
    ["POST /users/invite", "inviteUser"],
    ["POST /users/bulk-invite", "bulkInvite"],
    ["POST /users/invitations/:invitationId/resend", "resendInvite"],
    ["DELETE /users/invitations/:invitationId", "cancelInvite"],
    ["PATCH /users/invitations/:invitationId/role", "changeInviteRole"],
  ] as [string, keyof UsersController][])(
    "%s is gated on a key the HR module admin rung does not hold",
    (_route, method) => {
      const gate = usersGate(method);

      expect(gate).toBe(MEMBERSHIP_ADMIN_KEY);
      expect(gate === undefined || hrAdminRung.has(gate)).toBe(false);
    },
  );
});

describe("organisation administration keeps the authority", () => {
  it("the ORG_ADMIN rung still holds it", () => {
    expect(buildOrgAdminPermissionKeys(CATALOG)).toContain(MEMBERSHIP_ADMIN_KEY);
  });

  it("the seeded ORG_ADMIN spec still holds it", () => {
    const spec = systemRoleSpecs(CATALOG).find((candidate) => candidate.slug === "ORG_ADMIN");

    expect(spec?.permissionKeys).toContain(MEMBERSHIP_ADMIN_KEY);
  });

  it("the key is still in the catalog — the gate needs it and the owner resolves it", () => {
    expect(ALL_PERMISSION_NAMES).toContain(MEMBERSHIP_ADMIN_KEY);
  });
});

describe("the reconciler cannot re-add the key at the next boot", () => {
  const desired = buildDesiredGrants(CATALOG);

  it("computes a desired set for the HR rungs at all, so the check is not vacuous", () => {
    for (const slug of HR_RUNGS) expect(desired.get(slug)?.length ?? 0).toBeGreaterThan(0);
  });

  it("ORG_ADMIN is the only slug whose desired set contains it", () => {
    const holders = [...desired.entries()]
      .filter(([, grants]) => grants.some((g) => g.permissionKey === MEMBERSHIP_ADMIN_KEY))
      .map(([slug]) => slug);

    expect(holders).toEqual(["ORG_ADMIN"]);
  });
});

describe("migration 1094 withdraws the grant from organisations that already hold it", () => {
  const forward = executableSql(`${MIGRATION_TAG}.sql`);
  const rollback = executableSql(join("rollback", `${MIGRATION_TAG}.down.sql`));

  it("is registered in the journal, or it never runs while db:migrate prints success", () => {
    const journal: { entries: { idx: number; when: number; tag: string }[] } = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    );
    const index = journal.entries.findIndex((candidate) => candidate.tag === MIGRATION_TAG);

    expect(index).toBeGreaterThan(0);
    const entry = journal.entries[index];
    const previous = journal.entries[index - 1];
    expect(journal.entries.filter((candidate) => candidate.idx === entry.idx)).toHaveLength(1);
    expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("deletes the key from exactly the two HR rungs", () => {
    expect(forward).toMatch(/DELETE FROM "role_permission_grants"/i);
    expect(forward).toContain(`'${MEMBERSHIP_ADMIN_KEY}'`);
    expect(slugsNamedIn(forward)).toEqual([...HR_RUNGS]);
  });

  it("does not predicate on is_system — 0436 and 0990 did and matched nothing", () => {
    expect(forward).not.toMatch(/is_system/i);
  });

  it("names no organisation-level role in a slug predicate", () => {
    for (const slug of ["ORG_ADMIN", "OWNER", "MEMBER"])
      expect(slugsNamedIn(forward)).not.toContain(slug);
  });

  it("bumps permissions_version, so a revoked key does not survive in a warm cache", () => {
    expect(forward).toMatch(/INSERT INTO "access_versions"/i);
    expect(forward).toMatch(/permissions_version" \+ 1/);
  });

  it("is idempotent — every statement is a DELETE with an ON CONFLICT-guarded version bump", () => {
    const statements = readMigration(`${MIGRATION_TAG}.sql`)
      .split("--> statement-breakpoint")
      .map((chunk) =>
        chunk
          .split(/\r?\n/)
          .map((line) => line.replace(/--.*$/, ""))
          .join("\n")
          .trim(),
      )
      .filter((chunk) => chunk.length > 0);

    expect(statements.length).toBeGreaterThan(1);
    for (const statement of statements.slice(1)) {
      expect(statement).toMatch(/DELETE FROM/i);
      expect(statement).toMatch(/ON CONFLICT \("org_id"\) DO UPDATE/i);
    }
  });

  it("sets lock_timeout so it fails fast instead of queueing behind a reader", () => {
    expect(forward).toMatch(/SET lock_timeout/i);
  });

  it("has a rollback that restores the same two rungs and nothing else", () => {
    expect(rollback).toMatch(/INSERT INTO "role_permission_grants"/i);
    expect(rollback).toContain(`'${MEMBERSHIP_ADMIN_KEY}'`);
    for (const slug of HR_RUNGS) expect(rollback).toContain(`'${slug}'`);
    for (const slug of ["ORG_ADMIN", "OWNER", "MEMBER"])
      expect(rollback).not.toMatch(new RegExp(`'${slug}'`));
    expect(rollback).toMatch(/ON CONFLICT DO NOTHING/i);
  });

  it("guards the rollback on the catalog row, which the migration runner does not create", () => {
    expect(rollback).toMatch(/EXISTS \(\s*SELECT 1 FROM "permissions"/i);
  });
});
