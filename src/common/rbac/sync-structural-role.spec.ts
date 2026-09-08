import { drizzle } from "drizzle-orm/pg-proxy";
import {
  syncStructuralRoleAssignment,
  syncStructuralRoleAssignments,
} from "./sync-structural-role";
import { ORG_MEMBER_ROLES } from "./org-roles";
import type { DbOrTx } from "./access-invalidate";

const ORG = "org-1";
const MEMBERSHIP = 42;
const ADMIN_ROLE_ID = 7;
const MEMBER_ROLE_ID = 9;

type Statement = { sql: string; params: unknown[] };

const ADMIN_ROW = [ADMIN_ROLE_ID, ORG_MEMBER_ROLES.ORG_ADMIN];
const MEMBER_ROW = [MEMBER_ROLE_ID, ORG_MEMBER_ROLES.MEMBER];

function makeDb(roleRows: unknown[][]): { db: DbOrTx; captured: Statement[] } {
  const captured: Statement[] = [];
  const db = drizzle(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params });
    return { rows: sql.includes('from "roles"') ? roleRows : [] };
  });
  return { db: db as unknown as DbOrTx, captured };
}

function statementsOn(captured: Statement[], fragment: string): Statement[] {
  return captured.filter((statement) => statement.sql.includes(fragment));
}

function onlyStatementOn(captured: Statement[], fragment: string): Statement {
  const matches = statementsOn(captured, fragment);
  expect(matches).toHaveLength(1);
  return matches[0];
}

/** (membershipId, roleId) pairs an INSERT ... VALUES grants, read off the flattened params. */
function grantedPairs(statement: Statement): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index + 3 < statement.params.length; index += 4) {
    const membershipId = statement.params[index + 1];
    const roleId = statement.params[index + 2];
    if (typeof membershipId === "number" && typeof roleId === "number")
      pairs.push([membershipId, roleId]);
  }
  return pairs;
}

/** (membershipId, roleId) pairs a batched DELETE revokes: org, memberships…, roles…. */
function revokedPairs(statement: Statement, membershipCount: number): Array<[number, number]> {
  const memberships = statement.params.slice(1, 1 + membershipCount);
  const roleIds = statement.params.slice(1 + membershipCount);
  const pairs: Array<[number, number]> = [];
  for (const membershipId of memberships)
    for (const roleId of roleIds)
      if (typeof membershipId === "number" && typeof roleId === "number")
        pairs.push([membershipId, roleId]);
  return pairs;
}

/**
 * The per-membership contract, restated independently of the implementation so
 * the batched form is compared against the rule and not against a helper that
 * now shares its code.
 */
function perMembershipReference(
  membershipIds: readonly number[],
  role: string,
  adminRoleId: number | undefined,
  memberRoleId: number | undefined,
): { grants: Array<[number, number]>; revokes: Array<[number, number]>; bumped: boolean } {
  if (adminRoleId === undefined && memberRoleId === undefined)
    return { grants: [], revokes: [], bumped: false };

  const grants: Array<[number, number]> = [];
  const revokes: Array<[number, number]> = [];
  for (const membershipId of membershipIds) {
    if (role === ORG_MEMBER_ROLES.ORG_ADMIN) {
      if (adminRoleId !== undefined) grants.push([membershipId, adminRoleId]);
      if (memberRoleId !== undefined) revokes.push([membershipId, memberRoleId]);
    } else if (role === ORG_MEMBER_ROLES.MEMBER) {
      if (memberRoleId !== undefined) grants.push([membershipId, memberRoleId]);
      if (adminRoleId !== undefined) revokes.push([membershipId, adminRoleId]);
    } else {
      if (adminRoleId !== undefined) revokes.push([membershipId, adminRoleId]);
      if (memberRoleId !== undefined) revokes.push([membershipId, memberRoleId]);
    }
  }
  return { grants, revokes, bumped: true };
}

function sortPairs(pairs: Array<[number, number]>): string {
  return pairs
    .map(([membershipId, roleId]) => `${membershipId}:${roleId}`)
    .sort()
    .join(",");
}

describe("syncStructuralRoleAssignment", () => {
  it("creates the ORG_ADMIN role_assignments row when a membership becomes ORG_ADMIN", async () => {
    const { db, captured } = makeDb([ADMIN_ROW]);

    await syncStructuralRoleAssignment(db, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.ORG_ADMIN);

    const insert = onlyStatementOn(captured, 'insert into "role_assignments"');
    expect(grantedPairs(insert)).toEqual([[MEMBERSHIP, ADMIN_ROLE_ID]]);
    expect(insert.params).toContain(ORG);
    expect(statementsOn(captured, 'delete from "role_assignments"')).toHaveLength(0);
  });

  it("bumps the permissions version so the access cache cannot serve a stale answer", async () => {
    const { db, captured } = makeDb([ADMIN_ROW]);

    await syncStructuralRoleAssignment(db, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.ORG_ADMIN);

    const bump = onlyStatementOn(captured, 'insert into "access_versions"');
    expect(bump.sql).toContain('"permissions_version" = "access_versions"."permissions_version" + 1');
    expect(bump.params).toContain(ORG);
  });

  it("assigns the MEMBER role and removes the ORG_ADMIN assignment when demoted", async () => {
    const { db, captured } = makeDb([ADMIN_ROW, MEMBER_ROW]);

    await syncStructuralRoleAssignment(db, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.MEMBER);

    expect(grantedPairs(onlyStatementOn(captured, 'insert into "role_assignments"'))).toEqual([
      [MEMBERSHIP, MEMBER_ROLE_ID],
    ]);
    expect(revokedPairs(onlyStatementOn(captured, 'delete from "role_assignments"'), 1)).toEqual([
      [MEMBERSHIP, ADMIN_ROLE_ID],
    ]);
  });

  it("does not grant the ORG_ADMIN role to a plain MEMBER", async () => {
    const { db, captured } = makeDb([ADMIN_ROW, MEMBER_ROW]);

    await syncStructuralRoleAssignment(db, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.MEMBER);

    const granted = grantedPairs(onlyStatementOn(captured, 'insert into "role_assignments"'));
    expect(granted.some(([, roleId]) => roleId === ADMIN_ROLE_ID)).toBe(false);
  });

  it("revokes both structural roles and grants neither when the role is OWNER", async () => {
    const { db, captured } = makeDb([ADMIN_ROW, MEMBER_ROW]);

    await syncStructuralRoleAssignment(db, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.OWNER);

    expect(statementsOn(captured, 'insert into "role_assignments"')).toHaveLength(0);
    expect(
      sortPairs(revokedPairs(onlyStatementOn(captured, 'delete from "role_assignments"'), 1)),
    ).toBe(sortPairs([[MEMBERSHIP, ADMIN_ROLE_ID], [MEMBERSHIP, MEMBER_ROLE_ID]]));
  });

  it("is a no-op when the org has no seeded structural roles", async () => {
    const { db, captured } = makeDb([]);

    await syncStructuralRoleAssignment(db, ORG, MEMBERSHIP, ORG_MEMBER_ROLES.ORG_ADMIN);

    expect(statementsOn(captured, 'insert into "role_assignments"')).toHaveLength(0);
    expect(statementsOn(captured, 'delete from "role_assignments"')).toHaveLength(0);
    expect(statementsOn(captured, 'insert into "access_versions"')).toHaveLength(0);
  });
});

describe("syncStructuralRoleAssignments", () => {
  const MEMBERSHIPS = [11, 12, 13];

  it("reads both structural roles in one statement instead of one lookup per slug", async () => {
    const { db, captured } = makeDb([ADMIN_ROW, MEMBER_ROW]);

    await syncStructuralRoleAssignments(db, ORG, MEMBERSHIPS, ORG_MEMBER_ROLES.ORG_ADMIN);

    const select = onlyStatementOn(captured, 'from "roles"');
    expect(select.sql).toBe(
      'select "id", "slug" from "roles" where ("roles"."org_id" = $1 and "roles"."slug" in ($2, $3)) limit $4',
    );
    expect(select.params).toEqual([ORG, ORG_MEMBER_ROLES.ORG_ADMIN, ORG_MEMBER_ROLES.MEMBER, 2]);
  });

  it("grants through one multi-row INSERT ... ON CONFLICT DO NOTHING", async () => {
    const { db, captured } = makeDb([ADMIN_ROW, MEMBER_ROW]);

    await syncStructuralRoleAssignments(db, ORG, MEMBERSHIPS, ORG_MEMBER_ROLES.ORG_ADMIN);

    const insert = onlyStatementOn(captured, 'insert into "role_assignments"');
    expect(insert.sql).toContain("on conflict do nothing");
    expect(insert.sql.match(/\(default, \$/g)).toHaveLength(MEMBERSHIPS.length);
    expect(grantedPairs(insert)).toEqual(
      MEMBERSHIPS.map((membershipId) => [membershipId, ADMIN_ROLE_ID]),
    );
  });

  it("revokes through one DELETE whose predicate names only the non-granted structural role", async () => {
    const { db, captured } = makeDb([ADMIN_ROW, MEMBER_ROW]);

    await syncStructuralRoleAssignments(db, ORG, MEMBERSHIPS, ORG_MEMBER_ROLES.ORG_ADMIN);

    const remove = onlyStatementOn(captured, 'delete from "role_assignments"');
    expect(remove.sql).toBe(
      'delete from "role_assignments" where ("role_assignments"."org_id" = $1 and "role_assignments"."organization_membership_id" in ($2, $3, $4) and "role_assignments"."role_id" in ($5))',
    );
    expect(remove.params).toEqual([ORG, ...MEMBERSHIPS, MEMBER_ROLE_ID]);
  });

  it("issues four statements for any number of memberships", async () => {
    const many = Array.from({ length: 200 }, (_unused, index) => index + 1);
    const { db, captured } = makeDb([ADMIN_ROW, MEMBER_ROW]);

    await syncStructuralRoleAssignments(db, ORG, many, ORG_MEMBER_ROLES.ORG_ADMIN);

    expect(captured).toHaveLength(4);
  });

  it("bumps the permissions version exactly once, never zero times", async () => {
    const { db, captured } = makeDb([ADMIN_ROW, MEMBER_ROW]);

    await syncStructuralRoleAssignments(db, ORG, MEMBERSHIPS, ORG_MEMBER_ROLES.MEMBER);

    expect(statementsOn(captured, 'insert into "access_versions"')).toHaveLength(1);
  });

  it("produces exactly the grants and revokes N per-membership syncs produce", async () => {
    for (const role of [
      ORG_MEMBER_ROLES.ORG_ADMIN,
      ORG_MEMBER_ROLES.MEMBER,
      ORG_MEMBER_ROLES.OWNER,
      "SOMETHING_ELSE",
    ]) {
      for (const rows of [[ADMIN_ROW, MEMBER_ROW], [ADMIN_ROW], [MEMBER_ROW], []]) {
        const adminId = rows.includes(ADMIN_ROW) ? ADMIN_ROLE_ID : undefined;
        const memberId = rows.includes(MEMBER_ROW) ? MEMBER_ROLE_ID : undefined;
        const expected = perMembershipReference(MEMBERSHIPS, role, adminId, memberId);

        const { db, captured } = makeDb(rows);
        await syncStructuralRoleAssignments(db, ORG, MEMBERSHIPS, role);

        const grants = statementsOn(captured, 'insert into "role_assignments"').flatMap(
          grantedPairs,
        );
        const revokes = statementsOn(captured, 'delete from "role_assignments"').flatMap(
          (statement) => revokedPairs(statement, MEMBERSHIPS.length),
        );
        const bumped = statementsOn(captured, 'insert into "access_versions"').length;

        expect({ role, rows: rows.length, grants: sortPairs(grants) }).toEqual({
          role,
          rows: rows.length,
          grants: sortPairs(expected.grants),
        });
        expect({ role, rows: rows.length, revokes: sortPairs(revokes) }).toEqual({
          role,
          rows: rows.length,
          revokes: sortPairs(expected.revokes),
        });
        expect(bumped).toBe(expected.bumped ? 1 : 0);
      }
    }
  });

  it("writes nothing at all for an empty membership list", async () => {
    const { db, captured } = makeDb([ADMIN_ROW, MEMBER_ROW]);

    await syncStructuralRoleAssignments(db, ORG, [], ORG_MEMBER_ROLES.ORG_ADMIN);

    expect(captured).toHaveLength(0);
  });
});
