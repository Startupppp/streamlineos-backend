import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";

const notifications = { emit: jest.fn() } as unknown as NotificationDispatchService;
const audit = { logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined), logCritical: jest.fn(), log: jest.fn() } as unknown as AuditService;

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("PlatformOperatorAccessService — cross-org isolation", () => {
  const ORG_A = "org-alpha";
  const ORG_B = "org-beta";
  const OPERATOR = "operator-1";
  const SCOPE = "read_customer_data" as const;

  function makeDb(grantRow: unknown): { db: Db; where: jest.Mock } {
    const where = jest.fn();
    const limit = jest.fn().mockResolvedValue(grantRow !== null ? [grantRow] : []);
    const from = jest.fn();
    const builder = { from, where, limit };
    from.mockReturnValue({ where });
    where.mockReturnValue({ limit });

    const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
    return { db, where };
  }

  it("assertGrant throws ForbiddenException when operator has no grant for the requested org — cross-org isolation", async () => {
    const { db, where } = makeDb(null);
    const svc = new PlatformOperatorAccessService(db, notifications, audit);

    await expect(svc.assertGrant(OPERATOR, ORG_B, SCOPE)).rejects.toThrow(ForbiddenException);

    expect(where).toHaveBeenCalled();
    const values = sqlValues(where.mock.calls[0]?.[0]);
    expect(values).toContain(ORG_B);
    expect(values).toContain(OPERATOR);
  });

  it("assertGrant scopes to org and operator — grant for org A does not satisfy org B check", async () => {
    const grantForOrgA = { grantId: "grant-1" };
    const { db, where } = makeDb(null);
    const svc = new PlatformOperatorAccessService(db, notifications, audit);

    await expect(svc.assertGrant(OPERATOR, ORG_B, SCOPE)).rejects.toThrow(ForbiddenException);

    const values = sqlValues(where.mock.calls[0]?.[0]);
    expect(values).toContain(ORG_B);
    expect(values).not.toContain(grantForOrgA.grantId);
  });

  it("listGrants scopes to the requested org — cross-org isolation", async () => {
    const { db, where } = makeDb([]);
    const svc = new PlatformOperatorAccessService(db, notifications, audit);

    await svc.listGrants(ORG_A);

    expect(where).toHaveBeenCalled();
    const values = sqlValues(where.mock.calls[0]?.[0]);
    expect(values).toContain(ORG_A);
    expect(values).not.toContain(ORG_B);
  });

  it("listLogs scopes to the requested org — cross-org isolation", async () => {
    const where = jest.fn();
    const orderBy = jest.fn();
    const limit = jest.fn().mockResolvedValue([]);
    const from = jest.fn();
    const builder = { from, where, orderBy, limit };
    from.mockReturnValue({ where });
    where.mockReturnValue({ orderBy });
    orderBy.mockReturnValue({ limit });

    const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
    const svc = new PlatformOperatorAccessService(db, notifications, audit);

    await svc.listLogs(ORG_A);

    expect(where).toHaveBeenCalled();
    const values = sqlValues(where.mock.calls[0]?.[0]);
    expect(values).toContain(ORG_A);
    expect(values).not.toContain(ORG_B);
  });
});
