import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";

type ChainMock = Record<string, jest.Mock>;

function makeSelectChain(rows: unknown[]): ChainMock {
  const chain: ChainMock = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(rows);
  chain.then = jest.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve));
  return chain;
}

function makeInsertChain(returning: unknown[]): ChainMock {
  const chain: ChainMock = {};
  chain.values = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue(returning);
  return chain;
}

function makeUpdateChain(): ChainMock {
  const chain: ChainMock = {};
  chain.set = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue([{ grantId: "grant-1" }]);
  return chain;
}

function makeInsertLogChain(): ChainMock {
  const chain: ChainMock = {};
  chain.values = jest.fn().mockResolvedValue(undefined);
  return chain;
}

function makeTransactionDb<T extends Record<string, unknown>>(
  db: T,
  tx: Record<string, unknown>,
): T & { transaction: jest.Mock } {
  const transaction = {
    execute: jest.fn().mockResolvedValue([]),
    ...db,
    ...tx,
  };
  return {
    ...db,
    transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction)),
  } as T & { transaction: jest.Mock };
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

describe("PlatformOperatorAccessService.createGrant", () => {
  it("inserts with status=pending, records the request, and returns grantId", async () => {
    const grantInsert = makeInsertChain([{ grantId: "grant-abc" }]);
    const auditInsert = makeInsertLogChain();
    const membershipSelect = makeSelectChain([{ userId: "op-alice" }]);
    const tx = {
      select: jest.fn().mockReturnValue(membershipSelect),
      insert: jest.fn()
        .mockReturnValueOnce(grantInsert)
        .mockReturnValueOnce(auditInsert),
    };
    const db = makeTransactionDb({}, tx);
    const svc = await buildService(db);

    const id = await svc.createGrant({
      operatorUserId: "op-alice",
      orgId: "org-1",
      incidentRef: "INC-001",
      reason: "Customer incident investigation",
      grantedBy: "op-alice",
      scope: "read_customer_data",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(id).toBe("grant-abc");
    const valuesCall = grantInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesCall.status).toBe("pending");
    expect(auditInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      action: "grant.requested",
      grantId: "grant-abc",
      orgId: "org-1",
    }));
  });
});

describe("PlatformOperatorAccessService.createGrantAndLog", () => {
  it("keeps grant creation inside the same transaction as its audit insert", async () => {
    const auditFailure = new Error("audit database unavailable");
    const grantInsert = {
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ grantId: "grant-atomic" }]),
    };
    const auditInsert = {
      values: jest.fn().mockRejectedValue(auditFailure),
    };
    const membershipSelect = makeSelectChain([{ userId: "op-alice" }]);
    const tx = {
      select: jest.fn().mockReturnValue(membershipSelect),
      insert: jest.fn()
        .mockReturnValueOnce(grantInsert)
        .mockReturnValueOnce(auditInsert),
    };
    const db = makeTransactionDb({}, tx);
    const svc = await buildService(db);

    await expect(
      svc.createGrantAndLog(
        {
          operatorUserId: "op-alice",
          orgId: "org-1",
          incidentRef: "INC-ATOMIC",
          reason: "Investigate customer incident",
          grantedBy: "op-bob",
          scope: "read_customer_data",
          expiresAt: new Date(Date.now() + 60_000),
        },
        "203.0.113.10",
        { requestedBy: "op-bob" },
      ),
    ).rejects.toBe(auditFailure);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(auditInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "grant.requested",
        grantId: "grant-atomic",
        orgId: "org-1",
      }),
    );
  });

  it("keeps the mandatory notification intent in the grant transaction", async () => {
    const grantInsert = makeInsertChain([{ grantId: "grant-notified" }]);
    const auditInsert = makeInsertLogChain();
    const notification = { emit: jest.fn().mockResolvedValue({ deferred: true }) };
    const membershipSelect = makeSelectChain([{ userId: "op-alice" }]);
    const tx = {
      select: jest.fn().mockReturnValue(membershipSelect),
      insert: jest.fn()
        .mockReturnValueOnce(grantInsert)
        .mockReturnValueOnce(auditInsert),
    };
    const db = makeTransactionDb({}, tx);
    const module = await Test.createTestingModule({
      providers: [
        PlatformOperatorAccessService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: notification },
      ],
    }).compile();
    const svc = module.get(PlatformOperatorAccessService);

    await svc.createGrant({
      operatorUserId: "op-alice",
      orgId: "org-1",
      incidentRef: "INC-NOTIFY",
      reason: "Investigate customer incident",
      grantedBy: "op-bob",
      scope: "read_customer_data",
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(notification.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "security.operator_access.requested",
      orgId: "org-1",
      entityId: "grant-notified",
      notifySelf: true,
    }));
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("PlatformOperatorAccessService.approveGrant", () => {
  function makeApproveDb(grant: {
    grantId?: string;
    grantedBy: string;
    status: string;
    orgId?: string;
    operatorUserId?: string;
  }) {
    const row = {
      grantId: grant.grantId ?? "grant-1",
      grantedBy: grant.grantedBy,
      status: grant.status,
      orgId: grant.orgId ?? "org-1",
      operatorUserId: grant.operatorUserId ?? "op-alice",
    };
    const selectChain = makeSelectChain([row]);
    const updateChain = makeUpdateChain();
    return makeTransactionDb({
      select: jest.fn().mockReturnValue(selectChain),
      update: jest.fn().mockReturnValue(updateChain),
      insert: jest.fn().mockReturnValue(makeInsertLogChain()),
    }, {});
  }

  it("(bite proof) self-approval throws ForbiddenException — removing the check would make this pass instead of throw", async () => {
    const db = makeApproveDb({ grantedBy: "op-alice", status: "pending" });
    const svc = await buildService(db);
    await expect(svc.approveGrant("grant-1", "op-alice")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("succeeds when approverId differs from grantedBy", async () => {
    const db = makeApproveDb({ grantedBy: "op-alice", status: "pending" });
    const svc = await buildService(db);
    const result = await svc.approveGrant("grant-1", "op-bob");
    expect(result.orgId).toBe("org-1");
    expect(result.operatorUserId).toBe("op-alice");
    const updateDb = db.update.mock.results[0]?.value as ChainMock;
    const setCall = updateDb.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.status).toBe("active");
    expect(setCall.approverId).toBe("op-bob");
  });

  it("conflicts when the conditional transition updates no row", async () => {
    const selectChain = makeSelectChain([{
      grantId: "grant-1",
      grantedBy: "op-alice",
      status: "pending",
      orgId: "org-1",
      operatorUserId: "op-alice",
    }]);
    const updateChain = makeUpdateChain();
    updateChain.returning.mockResolvedValue([]);
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      update: jest.fn().mockReturnValue(updateChain),
      insert: jest.fn().mockReturnValue(makeInsertLogChain()),
    };
    const transactionalDb = makeTransactionDb(db, {});
    const svc = await buildService(transactionalDb);

    await expect(svc.approveGrant("grant-1", "op-bob")).rejects.toBeInstanceOf(ConflictException);
    expect(updateChain.where).toHaveBeenCalledWith(expect.anything());
  });

  it("throws ConflictException when grant is not pending", async () => {
    const db = makeApproveDb({ grantedBy: "op-alice", status: "active" });
    const svc = await buildService(db);
    await expect(svc.approveGrant("grant-1", "op-bob")).rejects.toBeInstanceOf(ConflictException);
  });

  it("(idempotent) returns success without writing when already active for the same approver", async () => {
    const row = {
      grantId: "grant-1",
      grantedBy: "op-alice",
      approverId: "op-charlie",
      status: "active",
      orgId: "org-1",
      operatorUserId: "op-alice",
    };
    const selectChain = makeSelectChain([row]);
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      update: jest.fn(),
    };
    const svc = await buildService(db);
    const result = await svc.approveGrant("grant-1", "op-charlie");
    expect(result.orgId).toBe("org-1");
    expect(result.operatorUserId).toBe("op-alice");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("(idempotent-bite) repeat approve by a DIFFERENT approver still conflicts", async () => {
    const row = {
      grantId: "grant-1",
      grantedBy: "op-alice",
      approverId: "op-charlie",
      status: "active",
      orgId: "org-1",
      operatorUserId: "op-alice",
    };
    const selectChain = makeSelectChain([row]);
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      update: jest.fn(),
    };
    const svc = await buildService(db);
    await expect(svc.approveGrant("grant-1", "op-dave")).rejects.toBeInstanceOf(ConflictException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("(idempotent-bite) approve after reject still conflicts", async () => {
    const row = {
      grantId: "grant-1",
      grantedBy: "op-alice",
      approverId: null,
      status: "rejected",
      orgId: "org-1",
      operatorUserId: "op-alice",
    };
    const selectChain = makeSelectChain([row]);
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      update: jest.fn(),
    };
    const svc = await buildService(db);
    await expect(svc.approveGrant("grant-1", "op-charlie")).rejects.toBeInstanceOf(ConflictException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("(bite proof) self-approval still forbidden on idempotent path", async () => {
    const row = {
      grantId: "grant-1",
      grantedBy: "op-alice",
      approverId: "op-alice",
      status: "active",
      orgId: "org-1",
      operatorUserId: "op-bob",
    };
    const selectChain = makeSelectChain([row]);
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      update: jest.fn(),
    };
    const svc = await buildService(db);
    const result = await svc.approveGrant("grant-1", "op-alice");
    expect(result.orgId).toBe("org-1");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when grant does not exist", async () => {
    const selectChain = makeSelectChain([]);
    const db = { select: jest.fn().mockReturnValue(selectChain) };
    const svc = await buildService(db);
    await expect(svc.approveGrant("no-such-grant", "op-bob")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("PlatformOperatorAccessService.assertGrant — expiry enforced at authorization time", () => {
  function makeAssertDb(rows: unknown[]) {
    const selectChain = makeSelectChain(rows);
    return { select: jest.fn().mockReturnValue(selectChain) };
  }

  it("(bite proof) pending grant fails authorization — status=pending is not active", async () => {
    const db = makeAssertDb([]);
    const svc = await buildService(db);
    await expect(
      svc.assertGrant("op-alice", "org-1", "read_customer_data"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("(bite proof) returns grantId when grant is active and unexpired", async () => {
    const db = makeAssertDb([{ grantId: "grant-active" }]);
    const svc = await buildService(db);
    const grantId = await svc.assertGrant("op-alice", "org-1", "read_customer_data");
    expect(grantId).toBe("grant-active");

    const selectCall = db.select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof selectCall.grantId).toBe("object");
  });

  it("expired grant — DB returns empty (expiresAt > now predicate excludes it)", async () => {
    const db = makeAssertDb([]);
    const svc = await buildService(db);
    await expect(
      svc.assertGrant("op-alice", "org-1", "read_customer_data"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("revoked grant — DB returns empty (revokedAt IS NULL predicate excludes it)", async () => {
    const db = makeAssertDb([]);
    const svc = await buildService(db);
    await expect(
      svc.assertGrant("op-alice", "org-1", "read_customer_data"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("PlatformOperatorAccessService.revokeGrant", () => {
  it("throws NotFoundException when grant does not exist", async () => {
    const selectChain = makeSelectChain([]);
    const db = { select: jest.fn().mockReturnValue(selectChain) };
    const svc = await buildService(db);
    await expect(svc.revokeGrant("no-such", "too noisy", "op-system")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("sets revokedAt on an existing grant", async () => {
    const selectChain = makeSelectChain([{ grantId: "grant-1", orgId: "org-1", operatorUserId: "op-alice" }]);
    const updateChain = makeUpdateChain();
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      update: jest.fn().mockReturnValue(updateChain),
      insert: jest.fn().mockReturnValue(makeInsertLogChain()),
    };
    const transactionalDb = makeTransactionDb(db, {});
    const svc = await buildService(transactionalDb);
    await svc.revokeGrant("grant-1", "access no longer needed", "op-bob");
    const setCall = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.revokedAt).toBeInstanceOf(Date);
    expect(setCall.revocationReason).toBe("access no longer needed");
  });
});

describe("PlatformOperatorAccessService.rejectGrant", () => {
  it("throws NotFoundException when grant does not exist", async () => {
    const selectChain = makeSelectChain([]);
    const db = { select: jest.fn().mockReturnValue(selectChain) };
    const svc = await buildService(db);
    await expect(svc.rejectGrant("no-such", "not justified", "op-system")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws ConflictException when grant is already active", async () => {
    const selectChain = makeSelectChain([{ grantId: "grant-1", status: "active" }]);
    const db = { select: jest.fn().mockReturnValue(selectChain) };
    const svc = await buildService(db);
    await expect(svc.rejectGrant("grant-1", "too late", "op-system")).rejects.toBeInstanceOf(ConflictException);
  });

  it("(idempotent) returns without error and skips the update when already rejected", async () => {
    const selectChain = makeSelectChain([{ grantId: "grant-1", status: "rejected" }]);
    const updateChain = makeUpdateChain();
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      update: jest.fn().mockReturnValue(updateChain),
    };
    const svc = await buildService(db);
    await svc.rejectGrant("grant-1", "second rejection attempt", "op-system");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("sets status=rejected on a pending grant", async () => {
    const selectChain = makeSelectChain([{ grantId: "grant-1", status: "pending", orgId: "org-1", operatorUserId: "op-alice" }]);
    const updateChain = makeUpdateChain();
    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      update: jest.fn().mockReturnValue(updateChain),
      insert: jest.fn().mockReturnValue(makeInsertLogChain()),
    };
    const transactionalDb = makeTransactionDb(db, {});
    const svc = await buildService(transactionalDb);
    await svc.rejectGrant("grant-1", "not justified", "op-bob");
    const setCall = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.status).toBe("rejected");
    expect(setCall.revocationReason).toBe("not justified");
  });
});

describe("PlatformOperatorAccessService.expirePendingGrants", () => {
  it("expires only pending grants whose requested expiry has passed", async () => {
    const selectChain = makeSelectChain([{ grantId: "grant-1", orgId: "org-1", operatorUserId: "op-alice" }]);
    const updateChain = makeUpdateChain();
    const db = makeTransactionDb({
      select: jest.fn().mockReturnValue(selectChain),
      update: jest.fn().mockReturnValue(updateChain),
      insert: jest.fn().mockReturnValue(makeInsertLogChain()),
    }, {});
    const svc = await buildService(db);

    await expect(svc.expirePendingGrants(new Date("2026-09-01T12:00:00.000Z"))).resolves.toBe(1);
    expect(updateChain.set).toHaveBeenCalledWith({ status: "expired" });
    expect(updateChain.where).toHaveBeenCalledWith(expect.anything());
  });

  it("returns zero when no stale pending rows are changed", async () => {
    const selectChain = makeSelectChain([]);
    const db = { select: jest.fn().mockReturnValue(selectChain) };
    const svc = await buildService(db);

    await expect(svc.expirePendingGrants()).resolves.toBe(0);
  });
});

describe("PlatformOperatorAccessService.recordAccess", () => {
  it("inserts an audit log row", async () => {
    const logChain = makeInsertLogChain();
    const db = { insert: jest.fn().mockReturnValue(logChain) };
    const svc = await buildService(db);
    await svc.recordAccess("grant-1", "op-alice", "org-1", "grant.approved", "1.2.3.4", { note: "ok" });
    expect(logChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: "grant-1",
        operatorUserId: "op-alice",
        orgId: "org-1",
        action: "grant.approved",
        ipAddress: "1.2.3.4",
        detail: { note: "ok" },
      }),
    );
  });
});
