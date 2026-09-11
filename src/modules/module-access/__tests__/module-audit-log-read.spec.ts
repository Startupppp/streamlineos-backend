import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleAccessService } from "../module-access.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

/**
 * `GET /module-access/:moduleKey/audit-log` — who was granted what inside a
 * module, and by whom — had no test at all. No spec called `getAuditLog`, so the
 * `view` gate that opens it, the org filter on the history read, the module
 * filter on it, and the org predicates on the two name lookups could each be
 * deleted with all 243 module-access tests green. The route carries no
 * `@RequirePermission`: it is authorized in the service by design (CLAUDE.md §2,
 * `@AuthorizedInService`), which makes that one gate call the entire access
 * control for it.
 *
 * The predicates are asserted as predicates, not as outcomes. A mocked query
 * returns whatever the mock says regardless of its WHERE, so an assertion on the
 * rows that come back would be green over an unscoped read.
 */

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const ORG = "org-audit-tenant";
const MODULE = "hr";

function actor(): CurrentUserContext {
  return {
    userId: "u-reader",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

const HISTORY = [
  {
    id: 2,
    action: "module_access.role_permissions_set",
    actorUserId: "u-admin",
    actorName: "Admin",
    actorEmail: "admin@example.test",
    targetId: "7",
    targetType: "role",
    metadata: { moduleKey: MODULE },
    ipAddress: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  },
  {
    id: 1,
    action: "module_access.member_added",
    actorUserId: "u-admin",
    actorName: "Admin",
    actorEmail: "admin@example.test",
    targetId: "u-target",
    targetType: "user",
    metadata: { moduleKey: MODULE },
    ipAddress: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
];

/**
 * Three reads, in the order the function makes them: the history page, then the
 * target-user names, then the target-role names.
 */
function auditDb() {
  const historyLimit = jest.fn().mockResolvedValue(HISTORY);
  const historyOrderBy = jest.fn().mockReturnValue({ limit: historyLimit });
  const historyWhere = jest.fn().mockReturnValue({ orderBy: historyOrderBy });
  const historyLeftJoin = jest.fn().mockReturnValue({ where: historyWhere });
  const historyFrom = jest.fn().mockReturnValue({ leftJoin: historyLeftJoin });

  const usersWhere = jest
    .fn()
    .mockResolvedValue([{ id: "u-target", name: "Target", email: "t@example.test" }]);
  const usersInnerJoin = jest.fn().mockReturnValue({ where: usersWhere });
  const usersFrom = jest.fn().mockReturnValue({ innerJoin: usersInnerJoin });

  const rolesWhere = jest.fn().mockResolvedValue([{ id: 7, name: "HR Admin" }]);
  const rolesFrom = jest.fn().mockReturnValue({ where: rolesWhere });

  const select = jest
    .fn()
    .mockReturnValueOnce({ from: historyFrom })
    .mockReturnValueOnce({ from: usersFrom })
    .mockReturnValueOnce({ from: rolesFrom });

  return { db: { select }, select, historyWhere, usersWhere, rolesWhere };
}

async function build(db: unknown): Promise<ModuleAccessService> {
  const ref = await Test.createTestingModule({
    providers: [
      ModuleAccessService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: {} },
      { provide: CacheService, useValue: {} },
      { provide: AuditService, useValue: {} },
    ],
  }).compile();
  return ref.get(ModuleAccessService);
}

describe("module access-change history — the gate", () => {
  it("refuses before reading anything when the caller may not view the module's access screen", async () => {
    const { db, select } = auditDb();
    const svc = await build(db);
    jest
      .spyOn(svc, "assertModuleAccess")
      .mockRejectedValue(new ForbiddenException("not for you"));

    await expect(svc.getAuditLog(actor(), MODULE, { limit: 20 })).rejects.toThrow(
      ForbiddenException,
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("asks for view — not manage — on the route's own module", async () => {
    const { db } = auditDb();
    const svc = await build(db);
    const gate = jest.spyOn(svc, "assertModuleAccess").mockResolvedValue(undefined);

    await svc.getAuditLog(actor(), MODULE, { limit: 20 });

    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG }), MODULE, "view");
  });
});

describe("module access-change history — what it may read", () => {
  async function readAs() {
    const harness = auditDb();
    const svc = await build(harness.db);
    jest.spyOn(svc, "assertModuleAccess").mockResolvedValue(undefined);
    const page = await svc.getAuditLog(actor(), MODULE, { limit: 20 });
    return { ...harness, page };
  }

  it("reads history only from the caller's org", async () => {
    const { historyWhere } = await readAs();
    expect(historyWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(historyWhere.mock.calls[0]?.[0])).toContain(ORG);
  });

  it("reads history only for the module in the route", async () => {
    const { historyWhere } = await readAs();
    expect(historyWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(historyWhere.mock.calls[0]?.[0])).toContain(MODULE);
  });

  /**
   * A history row can name any user id. Resolving it against every org's
   * members would put another tenant's user's name on this screen.
   */
  it("resolves a target user's name only among the caller's org's members", async () => {
    const { usersWhere, page } = await readAs();
    expect(usersWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(usersWhere.mock.calls[0]?.[0])).toContain(ORG);
    expect(page.data.find((row) => row.targetType === "user")?.targetName).toBe("Target");
  });

  it("resolves a target role's name only among the caller's org's roles", async () => {
    const { rolesWhere, page } = await readAs();
    expect(rolesWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(rolesWhere.mock.calls[0]?.[0])).toContain(ORG);
    expect(page.data.find((row) => row.targetType === "role")?.targetName).toBe("HR Admin");
  });
});
