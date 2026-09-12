import { organizations, permissions, rolePermissionGrants, roles } from "../../db/schema";
import { makeFakeDb, type TableRows } from "../../test/fake-select-db";
import { RoleGrantReconcilerService } from "./role-grant-reconciler.service";

/**
 * Cross-tenant isolation for the one service in the codebase that writes grants
 * for every organisation in one pass.
 *
 * There is no controller here and therefore no 404-vs-403 question to ask: the
 * reconciler is a `forEachOrg` sweep, so the tenant boundary it can breach is
 * not a probe returning the wrong status but a *write* landing under the wrong
 * `org_id`. The assertion sits where `orgId` actually reaches the query — the
 * two keyset drains and the insert — and the fake db evaluates the real
 * predicates rather than recording that they were passed.
 *
 * The trap row is the point. `role_permission_grants.role_id` is an integer
 * unique only per organisation, so organisation B legitimately holds a grant
 * naming role id 1 while organisation A's own role *is* id 1. Drop
 * `eq(rolePermissionGrants.orgId, orgId)` from `drainHeldGrantKeys` and
 * organisation A reads B's row as its own, concludes the key is already held,
 * and silently skips the insert — a permission lost in one tenant because of a
 * row in another, with nothing raised. Drop `eq(roles.orgId, orgId)` from
 * `drainCandidateRoles` and the sweep reconciles B's role while stamping A's
 * `orgId` onto the inserted rows. Both are asserted below.
 */
describe("RoleGrantReconcilerService — cross-tenant isolation", () => {
  const ORG_A = "org-a";
  const ORG_B = "org-b";
  const VIEW = "support:tickets:view";
  const REPLY = "support:tickets:reply";

  function tables(overrides: Partial<TableRows> = {}): TableRows {
    return {
      // Placed: `forEachOrg` skips an org with no `region`, since `withTenant` cannot reach it.
      organizations: [
        { id: ORG_A, status: "ACTIVE", deleted_at: null, region: "eu" },
        { id: ORG_B, status: "ACTIVE", deleted_at: null, region: "eu" },
      ],
      permissions: [{ name: VIEW }, { name: REPLY }],
      roles: [
        { id: 1, org_id: ORG_A, slug: "CUSTOMER_SUPPORT", version: 1 },
        { id: 2, org_id: ORG_B, slug: "CUSTOMER_SUPPORT", version: 1 },
      ],
      role_permission_grants: [
        { id: 1, org_id: ORG_B, role_id: 1, permission_key: VIEW, scope: "all" },
      ],
      ...overrides,
    };
  }

  function grantsFor(rows: TableRows, orgId: string, roleId: number): string[] {
    return (rows.role_permission_grants ?? [])
      .filter((row) => row.org_id === orgId && row.role_id === roleId)
      .map((row) => String(row.permission_key))
      .sort();
  }

  async function reconcile(rows: TableRows) {
    const db = makeFakeDb(
      rows,
      { organizations, permissions, roles, rolePermissionGrants },
      { persistInserts: true },
    );
    const service = new RoleGrantReconcilerService(db as never);
    return service.reconcileAllOrganizations();
  }

  it("does not let another organisation's grant on the same role id suppress a write", async () => {
    const rows = tables();

    const report = await reconcile(rows);

    expect(grantsFor(rows, ORG_A, 1)).toEqual([REPLY, VIEW]);
    expect(report.grantsInserted).toBe(4);
  });

  it("never writes a grant carrying one organisation's id and another's role", async () => {
    const rows = tables();

    await reconcile(rows);

    expect(grantsFor(rows, ORG_A, 2)).toEqual([]);
    expect(grantsFor(rows, ORG_B, 1)).toEqual([VIEW]);
    expect(grantsFor(rows, ORG_B, 2)).toEqual([REPLY, VIEW]);
  });

  it("leaves a role an administrator has already written alone, in either tenant", async () => {
    const rows = tables({
      roles: [
        { id: 1, org_id: ORG_A, slug: "CUSTOMER_SUPPORT", version: 2 },
        { id: 2, org_id: ORG_B, slug: "CUSTOMER_SUPPORT", version: 1 },
      ],
    });

    const report = await reconcile(rows);

    expect(grantsFor(rows, ORG_A, 1)).toEqual([]);
    expect(grantsFor(rows, ORG_B, 2)).toEqual([REPLY, VIEW]);
    expect(report.rolesSkippedAsAdministered).toBe(1);
  });

  it("inserts nothing on a second pass, so a boot after a boot is not a second write", async () => {
    const rows = tables();

    await reconcile(rows);
    const second = await reconcile(rows);

    expect(second.grantsInserted).toBe(0);
    expect(grantsFor(rows, ORG_A, 1)).toEqual([REPLY, VIEW]);
  });
});
