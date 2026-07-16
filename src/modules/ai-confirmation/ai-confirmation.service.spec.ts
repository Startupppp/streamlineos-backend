import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AiConfirmationService } from "./ai-confirmation.service";
import { DRIZZLE } from "../../db/drizzle.constants";

process.env.AI_CONFIRMATION_SECRET = "test-secret-for-unit-tests-32-chars-ok";

type ProposalStatus = "PROPOSED" | "CONFIRMED" | "EXECUTED" | "EXPIRED" | "CANCELLED";

interface FakeRow {
  id: number;
  orgId: string;
  userId: string;
  action: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: ProposalStatus;
  idempotencyKey: string | null;
  expiresAt: Date;
  executedAt: Date | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakeDb(rows: Map<number, FakeRow>) {
  let nextId = 1;

  const buildQuery = (filterFn?: (r: FakeRow) => boolean) => {
    let _filterFn = filterFn;
    let _limit: number | undefined;
    let _forUpdate = false;

    const chain = {
      from: () => chain,
      where: (fn?: (r: FakeRow) => boolean) => {
        if (fn) _filterFn = fn;
        return chain;
      },
      for: (_mode: string) => { _forUpdate = true; return chain; },
      limit: (n: number) => { _limit = n; return chain; },
      then: (resolve: (v: FakeRow[]) => void) => {
        let result = _filterFn ? Array.from(rows.values()).filter(_filterFn) : Array.from(rows.values());
        if (_limit) result = result.slice(0, _limit);
        return Promise.resolve(result).then(resolve);
      },
      [Symbol.toStringTag]: "Promise",
    };

    Object.defineProperty(chain, Symbol.iterator, { value: undefined });
    return {
      ...chain,
      [Symbol.asyncIterator]: undefined,
    };
  };

  const db: Record<string, unknown> = {
    select: () => ({
      from: () => ({
        where: (fn?: (r: FakeRow) => boolean) => ({
          for: () => ({
            limit: (n: number) => {
              return {
                then: (resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) => {
                  let result = fn ? Array.from(rows.values()).filter(fn) : Array.from(rows.values());
                  result = result.slice(0, n);
                  return Promise.resolve(result).then(resolve, reject);
                },
              };
            },
          }),
          limit: (n: number) => {
            return {
              then: (resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) => {
                let result = fn ? Array.from(rows.values()).filter(fn) : Array.from(rows.values());
                result = result.slice(0, n);
                return Promise.resolve(result).then(resolve, reject);
              },
            };
          },
        }),
      }),
    }),

    insert: () => ({
      values: (vals: Omit<FakeRow, "id" | "createdAt" | "updatedAt">) => ({
        returning: () => {
          const id = nextId++;
          const now = new Date();
          const row: FakeRow = {
            id,
            orgId: vals.orgId,
            userId: vals.userId,
            action: vals.action,
            payload: vals.payload,
            payloadHash: vals.payloadHash,
            status: (vals.status as ProposalStatus) ?? "PROPOSED",
            idempotencyKey: vals.idempotencyKey ?? null,
            expiresAt: vals.expiresAt,
            executedAt: null,
            result: null,
            createdAt: now,
            updatedAt: now,
          };
          rows.set(id, row);
          return Promise.resolve([row]);
        },
      }),
    }),

    update: () => ({
      set: (patch: Partial<FakeRow>) => ({
        where: (fn: (r: FakeRow) => boolean) => {
          let count = 0;
          for (const [id, row] of rows) {
            if (fn(row)) {
              rows.set(id, { ...row, ...patch });
              count++;
            }
          }
          return Promise.resolve({ rowCount: count });
        },
      }),
    }),

    transaction: async (cb: (tx: typeof db) => Promise<unknown>) => {
      return cb(db);
    },
  };

  return db;
}

function makeAuditMock() {
  return { log: jest.fn() };
}

async function buildSvc(rows: Map<number, FakeRow>) {
  const fakeDb = makeFakeDb(rows);
  const auditMock = makeAuditMock();
  const module = await Test.createTestingModule({
    providers: [
      AiConfirmationService,
      { provide: DRIZZLE, useValue: fakeDb },
      { provide: "AuditService", useValue: auditMock },
    ],
  })
    .overrideProvider("AuditService")
    .useValue(auditMock)
    .compile();

  const svc = module.get(AiConfirmationService);
  return { svc, auditMock };
}

async function buildSvcDirect(rows: Map<number, FakeRow>) {
  const fakeDb = makeFakeDb(rows);
  const auditMock = makeAuditMock();

  const svc = new AiConfirmationService(fakeDb as never, auditMock as never);
  return { svc, auditMock };
}

describe("AiConfirmationService", () => {
  describe("propose → confirm happy path", () => {
    it("returns a valid token and confirm resolves the payload", async () => {
      const rows = new Map<number, FakeRow>();
      const { svc } = await buildSvcDirect(rows);

      const proposed = await svc.propose({
        orgId: "org1",
        userId: "user1",
        action: "delete_record",
        payload: { recordId: "abc" },
      });

      expect(proposed.proposalId).toBe(1);
      expect(proposed.token).toMatch(/^\d+\.\d+\.[a-f0-9]+$/);

      const confirmed = await svc.confirm({
        token: proposed.token,
        actor: { orgId: "org1", userId: "user1" },
      });

      expect(confirmed.proposalId).toBe(1);
      expect(confirmed.action).toBe("delete_record");
      expect(confirmed.payload).toEqual({ recordId: "abc" });

      const storedRow = rows.get(1);
      expect(storedRow?.status).toBe("CONFIRMED");
    });
  });

  describe("tampered hmac", () => {
    it("throws ForbiddenException", async () => {
      const rows = new Map<number, FakeRow>();
      const { svc } = await buildSvcDirect(rows);

      const proposed = await svc.propose({
        orgId: "org1",
        userId: "user1",
        action: "send_email",
        payload: { to: "x@y.com" },
      });

      const parts = proposed.token.split(".");
      const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -4)}zzzz`;

      await expect(
        svc.confirm({ token: tampered, actor: { orgId: "org1", userId: "user1" } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("expired proposal", () => {
    it("throws BadRequestException and sets status EXPIRED", async () => {
      const rows = new Map<number, FakeRow>();
      const { svc } = await buildSvcDirect(rows);

      const proposed = await svc.propose({
        orgId: "org1",
        userId: "user1",
        action: "archive",
        payload: { id: 99 },
        ttlSeconds: 1,
      });

      const row = rows.get(proposed.proposalId);
      if (row) rows.set(proposed.proposalId, { ...row, expiresAt: new Date(Date.now() - 5000) });

      await expect(
        svc.confirm({ token: proposed.token, actor: { orgId: "org1", userId: "user1" } }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(rows.get(proposed.proposalId)?.status).toBe("EXPIRED");
    });
  });

  describe("wrong actor orgId", () => {
    it("throws ForbiddenException", async () => {
      const rows = new Map<number, FakeRow>();
      const { svc } = await buildSvcDirect(rows);

      const proposed = await svc.propose({
        orgId: "org1",
        userId: "user1",
        action: "transfer",
        payload: {},
      });

      await expect(
        svc.confirm({ token: proposed.token, actor: { orgId: "org-WRONG", userId: "user1" } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("wrong actor userId", () => {
    it("throws ForbiddenException", async () => {
      const rows = new Map<number, FakeRow>();
      const { svc } = await buildSvcDirect(rows);

      const proposed = await svc.propose({
        orgId: "org1",
        userId: "user1",
        action: "purge",
        payload: { target: "all" },
      });

      await expect(
        svc.confirm({ token: proposed.token, actor: { orgId: "org1", userId: "user-WRONG" } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("double confirm", () => {
    it("throws ConflictException on second confirm", async () => {
      const rows = new Map<number, FakeRow>();
      const { svc } = await buildSvcDirect(rows);

      const proposed = await svc.propose({
        orgId: "org1",
        userId: "user1",
        action: "bulk_delete",
        payload: { ids: [1, 2, 3] },
      });

      await svc.confirm({ token: proposed.token, actor: { orgId: "org1", userId: "user1" } });

      await expect(
        svc.confirm({ token: proposed.token, actor: { orgId: "org1", userId: "user1" } }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("markExecuted idempotent", () => {
    it("second call returns without error", async () => {
      const rows = new Map<number, FakeRow>();
      const { svc } = await buildSvcDirect(rows);

      const proposed = await svc.propose({
        orgId: "org1",
        userId: "user1",
        action: "export",
        payload: { format: "csv" },
      });

      await svc.confirm({ token: proposed.token, actor: { orgId: "org1", userId: "user1" } });
      await svc.markExecuted(proposed.proposalId, { exportedRows: 42 });
      await expect(svc.markExecuted(proposed.proposalId, { exportedRows: 42 })).resolves.toBeUndefined();

      expect(rows.get(proposed.proposalId)?.status).toBe("EXECUTED");
    });
  });

  describe("sweepExpired", () => {
    it("returns count of rows updated", async () => {
      const rows = new Map<number, FakeRow>();
      const { svc } = await buildSvcDirect(rows);

      await svc.propose({ orgId: "org1", userId: "u1", action: "a1", payload: {} });
      await svc.propose({ orgId: "org1", userId: "u1", action: "a2", payload: {} });

      const row1 = rows.get(1);
      const row2 = rows.get(2);
      if (row1) rows.set(1, { ...row1, expiresAt: new Date(Date.now() - 10000) });
      if (row2) rows.set(2, { ...row2, expiresAt: new Date(Date.now() - 10000) });

      const count = await svc.sweepExpired();
      expect(count).toBe(2);
      expect(rows.get(1)?.status).toBe("EXPIRED");
      expect(rows.get(2)?.status).toBe("EXPIRED");
    });
  });
});