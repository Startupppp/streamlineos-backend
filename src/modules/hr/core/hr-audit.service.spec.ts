import {
  decodeAuditLogCursor,
  encodeAuditLogCursor,
} from "./hr-audit-cursor";
import { HrAuditService } from "./hr-audit.service";

function auditRow(auditLogId: number, createdAt: string) {
  return {
    id: auditLogId,
    orgId: "org-1",
    actorId: "actor-1",
    entityType: "employee",
    entityId: "employee-1",
    action: "updated",
    before: null,
    after: null,
    ipAddress: null,
    userAgent: null,
    createdAt: new Date(createdAt),
  };
}

describe("HrAuditService cursor list", () => {
  it("uses one limit-plus-one query and emits a stable tie-break cursor", async () => {
    const rows = [
      auditRow(43, "2026-08-18T08:00:00.000Z"),
      auditRow(42, "2026-08-18T08:00:00.000Z"),
      auditRow(41, "2026-08-17T08:00:00.000Z"),
    ];
    const queryChain = {
      from: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn().mockResolvedValue(rows),
    };
    queryChain.from.mockReturnValue(queryChain);
    queryChain.where.mockReturnValue(queryChain);
    queryChain.orderBy.mockReturnValue(queryChain);
    const db = { select: jest.fn().mockReturnValue(queryChain) };
    const service = new HrAuditService(db as never);

    const result = await service.list("org-1", { limit: 2 });

    expect(result.data.map((row) => row.id)).toEqual([43, 42]);
    expect(result.pageInfo).toMatchObject({ limit: 2, hasMore: true });
    const cursor = decodeAuditLogCursor(result.pageInfo.nextCursor ?? "");
    expect(cursor).toMatchObject({
      createdAt: "2026-08-18T08:00:00.000Z",
      auditLogId: 42,
    });
    expect(queryChain.limit).toHaveBeenCalledWith(3);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("applies a supplied cursor without issuing an exact-count query", async () => {
    const queryChain = {
      from: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn().mockResolvedValue([]),
    };
    queryChain.from.mockReturnValue(queryChain);
    queryChain.where.mockReturnValue(queryChain);
    queryChain.orderBy.mockReturnValue(queryChain);
    const db = { select: jest.fn().mockReturnValue(queryChain) };
    const service = new HrAuditService(db as never);
    const page = await service.list("org-1", {
      limit: 1,
      cursor: encodeAuditLogCursor({
        asOf: "2026-08-18T08:00:00.000Z",
        createdAt: "2026-08-17T08:00:00.000Z",
        auditLogId: 41,
      }),
    });

    expect(page.pageInfo).toEqual({
      limit: 1,
      hasMore: false,
      nextCursor: null,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
