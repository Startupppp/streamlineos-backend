import "reflect-metadata";
import { memberRowReader } from "../../../../test/helpers/membership-state-stub";
import { AccessPermissionResolver } from "../access-permission.resolver";
import { MANAGER_AUTHORITY_GRANTS } from "../access-policy";
import { AccessModule } from "../access.module";
import { ManagerStandingReader } from "../manager-standing.reader";
import { GRANT_SOURCE_KINDS } from "../access-explain-provenance";
import { PERMISSIONS } from "../../rbac/permissions";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-1";
const USER = "u-1";

function buildResolver(managesSomeone: boolean | null) {
  const chain = () => {
    const link: Record<string, unknown> = {};
    link["from"] = () => link;
    link["innerJoin"] = () => link;
    link["where"] = () => link;
    link["orderBy"] = () => link;
    link["limit"] = () => Promise.resolve([]);
    return link;
  };
  const db = { query: {}, select: () => chain() } as unknown as Db;
  return new AccessPermissionResolver(
    () => db,
    (read) => read() as Promise<never>,
    new Set<string>(),
    new Map(),
    1000,
    memberRowReader({ isOwner: false, status: "ACTIVE", id: 42, role: "MEMBER" }),
    undefined,
    managesSomeone === null ? null : async () => managesSomeone,
  );
}

describe("a person with a live direct report holds the approving keys their reports' requests route to", () => {
  it("grants leave, workflow and timesheet approval at the scope that means 'routed to me'", async () => {
    const resolved = (await buildResolver(true).computeUserPermissions(ORG, USER, 1)).perms;

    expect(resolved["hr:leaves:approve"]).toBe("own");
    expect(resolved["hr:leaves:view"]).toBe("all");
    expect(resolved["hr:workflows:approve"]).toBe("all");
    expect(resolved["timesheets:approvals:view"]).toBe("own");
    expect(resolved["timesheets:approvals:manage"]).toBe("own");
  });

  it("lets a manager open the exits routed to them, so the handover item they own is reachable", async () => {
    const resolved = (await buildResolver(true).computeUserPermissions(ORG, USER, 1)).perms;

    expect(resolved["hr:exit:view"]).toBe("own");
    expect(resolved["hr:exit:manage"]).toBeUndefined();
  });

  it("grants nothing extra to a member with no direct reports", async () => {
    const resolved = (await buildResolver(false).computeUserPermissions(ORG, USER, 1)).perms;

    for (const grant of MANAGER_AUTHORITY_GRANTS) expect(resolved[grant.permissionKey]).toBeUndefined();
  });

  it("grants nothing when no standing reader is wired, so a fake database can never confer authority", async () => {
    const resolved = (await buildResolver(null).computeUserPermissions(ORG, USER, 1)).perms;

    for (const grant of MANAGER_AUTHORITY_GRANTS) expect(resolved[grant.permissionKey]).toBeUndefined();
  });

  it("never widens a manager to the whole organisation: no manager-authority grant on a scopable key is 'all'", () => {
    const scopable = new Set(PERMISSIONS.filter((permission) => permission.scopable).map((permission) => permission.name));
    for (const grant of MANAGER_AUTHORITY_GRANTS) {
      expect(PERMISSIONS.some((permission) => permission.name === grant.permissionKey)).toBe(true);
      if (scopable.has(grant.permissionKey)) expect(grant.scope).toBe("own");
    }
  });

  it("is wired in production: AccessModule provides the standing reader the optional injection needs", () => {
    const providers: unknown[] = Reflect.getMetadata("providers", AccessModule) ?? [];
    expect(providers).toContain(ManagerStandingReader);
  });

  it("names its provenance so the access explanation can attribute it", () => {
    expect(GRANT_SOURCE_KINDS).toContain("manager-authority");
  });
});
