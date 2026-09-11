import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";

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

function renderCondition(condition: unknown): string {
  return new PgDialect().sqlToQuery(condition as SQL).sql;
}

async function buildService(db: unknown): Promise<PlatformOperatorAccessService> {
  const module = await Test.createTestingModule({
    providers: [
      PlatformOperatorAccessService,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationDispatchService, useValue: { emit: jest.fn() } },
    ],
  }).compile();
  return module.get(PlatformOperatorAccessService);
}

describe("PlatformOperatorAccessService — Item E: break-glass policy", () => {
  describe("createGrant: max 4-hour duration enforced", () => {
    it("rejects an expiry in the past instead of creating an unusable pending grant", async () => {
      const db = { insert: jest.fn() };
      const svc = await buildService(db);

      await expect(
        svc.createGrant({
          operatorUserId: "op-alice",
          orgId: "org-1",
          incidentRef: "INC-100",
          reason: "Investigate customer incident",
          grantedBy: "op-bob",
          scope: "read_customer_data",
          expiresAt: new Date(Date.now() - 1),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("(bite proof) rejects a grant expiring more than 4 hours from now", async () => {
      const insertChain = { values: jest.fn().mockReturnThis(), returning: jest.fn().mockResolvedValue([{ grantId: "g1" }]) };
      const db = { insert: jest.fn().mockReturnValue(insertChain) };
      const svc = await buildService(db);

      const tooFar = new Date(Date.now() + 5 * 60 * 60 * 1000);
      await expect(
        svc.createGrant({
          operatorUserId: "op-alice",
          orgId: "org-1",
          incidentRef: "INC-100",
          reason: "Investigate customer incident",
          grantedBy: "op-alice",
          scope: "read_customer_data",
          expiresAt: tooFar,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(db.insert).not.toHaveBeenCalled();
    });

    it("accepts a grant expiring within 4 hours", async () => {
      const grantInsert = { values: jest.fn().mockReturnThis(), returning: jest.fn().mockResolvedValue([{ grantId: "g1" }]) };
      const auditInsert = { values: jest.fn().mockResolvedValue(undefined) };
      const membership = { from: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue([{ userId: "op-alice" }]) };
      const tx = { execute: jest.fn().mockResolvedValue([]), select: jest.fn().mockReturnValue(membership), insert: jest.fn().mockReturnValueOnce(grantInsert).mockReturnValueOnce(auditInsert) };
      const db = { transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
      const svc = await buildService(db);

      const within4h = new Date(Date.now() + 3 * 60 * 60 * 1000);
      const id = await svc.createGrant({
        operatorUserId: "op-alice",
        orgId: "org-1",
        incidentRef: "INC-100",
        reason: "Investigate customer incident",
        grantedBy: "op-alice",
        scope: "read_customer_data",
        expiresAt: within4h,
      });
      expect(id).toBe("g1");
    });
  });

  describe("assertGrant: expiry predicate is in the SQL WHERE clause", () => {
    it("(bite proof) WHERE clause contains expiresAt condition — removing it would allow expired grants", async () => {
      const capturedConditions: unknown[] = [];
      const where = jest.fn((condition: unknown) => {
        capturedConditions.push(condition);
        return { limit: jest.fn().mockResolvedValue([]) };
      });
      const from = jest.fn().mockReturnValue({ where });
      const db = { select: jest.fn().mockReturnValue({ from }) };
      const svc = await buildService(db);

      await svc.assertGrant("op-alice", "org-1", "read_customer_data").catch(() => null);

      expect(capturedConditions.length).toBeGreaterThan(0);
      const rendered = renderCondition(capturedConditions[0]);
      expect(rendered).toContain("expires_at");
    });

    it("WHERE clause contains status = 'active' — pending grants are rejected", async () => {
      const capturedConditions: unknown[] = [];
      const where = jest.fn((condition: unknown) => {
        capturedConditions.push(condition);
        return { limit: jest.fn().mockResolvedValue([]) };
      });
      const from = jest.fn().mockReturnValue({ where });
      const db = { select: jest.fn().mockReturnValue({ from }) };
      const svc = await buildService(db);

      await svc.assertGrant("op-alice", "org-1", "read_customer_data").catch(() => null);

      const values = sqlValues(capturedConditions[0]);
      expect(values).toContain("active");
    });

    it("(bite proof) expired grant — DB applies expiry predicate, returns empty, throws ForbiddenException", async () => {
      const where = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
      const from = jest.fn().mockReturnValue({ where });
      const db = { select: jest.fn().mockReturnValue({ from }) };
      const svc = await buildService(db);

      await expect(
        svc.assertGrant("op-alice", "org-1", "read_customer_data"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("revokeGrant: updates status to 'revoked' for query-time enforcement consistency", () => {
    it("(bite proof) sets status='revoked' and revokedAt — status column stays consistent with revokedAt", async () => {
      const selectChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ grantId: "grant-1", orgId: "org-1", operatorUserId: "op-alice" }]),
      };
      const updateChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ grantId: "grant-1" }]),
      };
      const updateMock = jest.fn().mockReturnValue(updateChain);
      const insertMock = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });
      const transaction = { execute: jest.fn().mockResolvedValue([]), update: updateMock, insert: insertMock };
      const db = {
        select: jest.fn().mockReturnValue(selectChain),
        update: updateMock,
        insert: insertMock,
        transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
      };
      const svc = await buildService(db);

      await svc.revokeGrant("grant-1", "no longer needed", "op-bob");

      const setCall = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(setCall.status).toBe("revoked");
      expect(setCall.revokedAt).toBeInstanceOf(Date);
      expect(setCall.revocationReason).toBe("no longer needed");
    });
  });

  describe("assertAndLog: every privileged action carries both operatorUserId and grantId", () => {
    it("recordAccess call includes grantId and operatorUserId — actions are doubly attributed", async () => {
      const capturedLog: Record<string, unknown>[] = [];
      const grantSelectChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ grantId: "grant-active" }]),
      };
      const logInsertChain = {
        values: jest.fn((v: unknown) => {
          capturedLog.push(v as Record<string, unknown>);
          return Promise.resolve(undefined);
        }),
      };
      const db = {
        select: jest.fn().mockReturnValue(grantSelectChain),
        insert: jest.fn().mockReturnValue(logInsertChain),
      };
      const svc = await buildService(db);

      await svc.assertAndLog(
        "op-alice",
        "org-1",
        "read_customer_data",
        "customer_data.viewed",
        "1.2.3.4",
        { recordId: "cust-abc" },
      );

      expect(capturedLog).toHaveLength(1);
      expect(capturedLog[0]).toMatchObject({
        grantId: "grant-active",
        operatorUserId: "op-alice",
        action: "customer_data.viewed",
        orgId: "org-1",
        ipAddress: "1.2.3.4",
      });
    });
  });

  describe("approveGrant: the beneficiary may never approve their own grant", () => {
    function grantDb(grant: Record<string, unknown>) {
      const limit = jest.fn().mockResolvedValue([grant]);
      const where = jest.fn().mockReturnValue({ limit });
      const from = jest.fn().mockReturnValue({ where });
      return {
        select: jest.fn().mockReturnValue({ from }),
        transaction: jest.fn(),
        insert: jest.fn(),
      };
    }

    it("denies when a third party filed the request and the operator approves it", async () => {
      const db = grantDb({
        grantId: "g1",
        grantedBy: "op-carol",
        approverId: null,
        status: "pending",
        orgId: "org-1",
        operatorUserId: "op-alice",
      });
      const svc = await buildService(db);

      await expect(svc.approveGrant("g1", "op-alice")).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("(bite proof) the grantedBy check alone does not catch it — requester and beneficiary differ", async () => {
      const db = grantDb({
        grantId: "g1",
        grantedBy: "op-carol",
        approverId: null,
        status: "pending",
        orgId: "org-1",
        operatorUserId: "op-alice",
      });
      const svc = await buildService(db);

      await expect(svc.approveGrant("g1", "op-alice")).rejects.toThrow(
        "the operator receiving access cannot approve their own grant",
      );
    });

    it("does not replay a legacy grant that was already approved by its own beneficiary", async () => {
      const db = grantDb({
        grantId: "g1",
        grantedBy: "op-carol",
        approverId: "op-alice",
        status: "active",
        orgId: "org-1",
        operatorUserId: "op-alice",
      });
      const svc = await buildService(db);

      await expect(svc.approveGrant("g1", "op-alice")).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("still allows an independent approver", async () => {
      const updateChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ grantId: "g1" }]),
      };
      const tx = {
        execute: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockReturnValue(updateChain),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      };
      const db = grantDb({
        grantId: "g1",
        grantedBy: "op-carol",
        approverId: null,
        status: "pending",
        orgId: "org-1",
        operatorUserId: "op-alice",
      });
      db.transaction = jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));
      const svc = await buildService(db);

      await expect(svc.approveGrant("g1", "op-bob")).resolves.toEqual({
        orgId: "org-1",
        operatorUserId: "op-alice",
      });
      expect(tx.update).toHaveBeenCalled();
    });
  });
});
