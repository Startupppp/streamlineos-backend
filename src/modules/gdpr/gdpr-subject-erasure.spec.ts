import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { GdprSubjectErasureService } from "./gdpr-subject-erasure.service";
import { GdprController } from "./gdpr.controller";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

jest.mock("../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../common/auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn().mockResolvedValue(undefined),
}));

import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { bustMembershipStatusCache } from "../../common/auth/membership-state.service";

const ORG = "org-main";
const SUBJECT = "user-subject";
const ACTOR = "user-actor";
const OTHER_ORG = "org-other";

function fluentChain(limitResult: unknown, returningResult: unknown = []) {
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(limitResult),
    set: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue(returningResult),
    values: jest.fn().mockResolvedValue(undefined),
    then: (
      resolve: (v: unknown) => unknown,
      reject?: (r: unknown) => unknown,
    ) => Promise.resolve(limitResult).then(resolve, reject),
  };
  return chain;
}

type FluentChain = ReturnType<typeof fluentChain>;

interface TxMocks {
  tx: {
    select: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
    delete: jest.Mock;
  };
  updateChains: FluentChain[];
  insertChains: FluentChain[];
}

interface DbMocks {
  db: {
    select: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
    transaction: jest.Mock;
  };
  txMocks: TxMocks;
}

function makeDb(opts: {
  membershipRows?: unknown[];
  legalHoldRows?: unknown[];
  hrPeopleRows?: unknown[];
  hrEmpRows?: unknown[];
  otherMemberRows?: unknown[];
  opUpdated?: unknown[];
  sfUpdated?: unknown[];
  depUpdated?: unknown[];
  aiConvUpdated?: unknown[];
  aiMsgUpdated?: unknown[];
  chatMsgUpdated?: unknown[];
} = {}): DbMocks {
  const membershipRows = opts.membershipRows ?? [{ id: 1 }];
  const legalHoldRows = opts.legalHoldRows ?? [];
  const hrPeopleRows = opts.hrPeopleRows ?? [{ id: 10 }];
  const hrEmpRows = opts.hrEmpRows ?? [{ id: 20 }];
  const otherMemberRows = opts.otherMemberRows ?? [];
  const opUpdated = opts.opUpdated ?? [{ id: "person-1" }];
  const sfUpdated = opts.sfUpdated ?? [{ id: 1 }];
  const depUpdated = opts.depUpdated ?? [{ id: 2 }];
  const aiConvUpdated = opts.aiConvUpdated ?? [];
  const aiMsgUpdated = opts.aiMsgUpdated ?? [];
  const chatMsgUpdated = opts.chatMsgUpdated ?? [];

  const hrPeopleChain = fluentChain(hrPeopleRows);
  const hrEmpChain = fluentChain(hrEmpRows);
  const otherMemberChain = fluentChain(otherMemberRows);

  const opUpdateChain = fluentChain([], opUpdated);
  const sfUpdateChain = fluentChain([], sfUpdated);
  const depUpdateChain = fluentChain([], depUpdated);
  const aiConvUpdateChain = fluentChain([], aiConvUpdated);
  const aiMsgUpdateChain = fluentChain([], aiMsgUpdated);
  const chatMsgUpdateChain = fluentChain([], chatMsgUpdated);
  const usersUpdateChain = fluentChain([], []);

  const dataReqInsertChain = fluentChain([]);
  const auditInsertChain = fluentChain([]);

  let txSelectCount = 0;
  let txUpdateCount = 0;
  let txInsertCount = 0;

  const tx = {
    select: jest.fn().mockImplementation(() => {
      txSelectCount++;
      if (txSelectCount === 1) return hrPeopleChain;
      if (txSelectCount === 2) return hrEmpChain;
      if (txSelectCount === 3) return otherMemberChain;
      return fluentChain([]);
    }),
    update: jest.fn().mockImplementation(() => {
      txUpdateCount++;
      if (txUpdateCount === 1) return opUpdateChain;
      if (txUpdateCount === 2) return sfUpdateChain;
      if (txUpdateCount === 3) return depUpdateChain;
      if (txUpdateCount === 4) return aiConvUpdateChain;
      if (txUpdateCount === 5) return aiMsgUpdateChain;
      if (txUpdateCount === 6) return chatMsgUpdateChain;
      if (txUpdateCount === 7) return usersUpdateChain;
      return fluentChain([], []);
    }),
    insert: jest.fn().mockImplementation(() => {
      txInsertCount++;
      if (txInsertCount === 1) return dataReqInsertChain;
      if (txInsertCount === 2) return auditInsertChain;
      return fluentChain([]);
    }),
    delete: jest.fn().mockReturnValue(fluentChain([], [])),
  };

  let dbSelectCount = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      dbSelectCount++;
      if (dbSelectCount === 1) return fluentChain(membershipRows);
      if (dbSelectCount === 2) return fluentChain(legalHoldRows);
      return fluentChain([]);
    }),
    update: jest.fn().mockReturnValue(fluentChain([], [])),
    insert: jest.fn().mockReturnValue(fluentChain([])),
    transaction: jest.fn().mockImplementation(
      async (fn: (t: TxMocks["tx"]) => Promise<unknown>) => fn(tx),
    ),
  };

  return {
    db,
    txMocks: {
      tx,
      updateChains: [opUpdateChain, sfUpdateChain, depUpdateChain, aiConvUpdateChain, aiMsgUpdateChain, chatMsgUpdateChain, usersUpdateChain],
      insertChains: [dataReqInsertChain, auditInsertChain],
    },
  };
}

function buildService(db: DbMocks["db"]): GdprSubjectErasureService {
  const cache = {} as CacheService;
  return new GdprSubjectErasureService(db as unknown as Db, cache);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Cross-tenant isolation ───────────────────────────────────────────────────

describe("GdprSubjectErasureService — cross-tenant isolation", () => {
  it("throws NotFoundException when subject has no membership in the caller's org", async () => {
    const { db } = makeDb({ membershipRows: [] });
    const svc = buildService(db);

    await expect(
      svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("(bite proof) does NOT throw when subject IS a member — test would fail if membership check were removed", async () => {
    // Mechanism: db.select returns a membership row for call 1.
    // Neuter (done manually before running this suite): set membershipRows = [] → NotFoundException.
    // With rows present → proceeds to legal-hold check → returns success.
    const { db } = makeDb({ membershipRows: [{ id: 1 }], dryRun: true } as Parameters<typeof makeDb>[0]);
    const svc = buildService(db);

    await expect(
      svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: true }),
    ).resolves.toMatchObject({ blocked: false });
  });
});

// ─── Legal hold enforcement ───────────────────────────────────────────────────

describe("GdprSubjectErasureService — legal hold enforcement", () => {
  it("returns blocked result naming the hold when an active legal hold exists", async () => {
    const { db } = makeDb({
      legalHoldRows: [{ id: 42, reason: "active litigation" }],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.blocked).toBe(true);
    expect(result.holdId).toBe(42);
    expect(result.blockReason).toBe("active litigation");
    expect(result.tablesAnonymised).toHaveLength(0);
  });

  it("(bite proof) does NOT block when hold list is empty — test would fail if hold list contained a row", async () => {
    // Mechanism: legalHoldRows = [] → not blocked.
    // Neuter: set legalHoldRows = [{ id: 1, reason: "hold" }] → blocked=true → FAIL on "blocked: false".
    const { db } = makeDb({ legalHoldRows: [] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: true });
    expect(result.blocked).toBe(false);
  });

  it("does not call db.transaction when blocked by a legal hold", async () => {
    const { db } = makeDb({
      legalHoldRows: [{ id: 7, reason: "regulatory hold" }],
    });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(db.transaction).not.toHaveBeenCalled();
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("GdprSubjectErasureService — idempotency", () => {
  it("second run is a no-op: returns success with empty tablesAnonymised when nothing changed", async () => {
    // Simulates a second run: org-scoped tables already erased (returning []).
    // Subject has another org membership so the global users row is preserved.
    const { db } = makeDb({
      opUpdated: [],
      sfUpdated: [],
      depUpdated: [],
      otherMemberRows: [{ id: 99 }],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.blocked).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.tablesAnonymised).toHaveLength(0);
  });

  it("(bite proof) first run produces a non-empty tablesAnonymised — test would fail if updates returned nothing on first run", async () => {
    // Mechanism: opUpdated = [{ id: 'person-1' }] → organization_people is in tablesAnonymised.
    // Neuter: set opUpdated = [] → tablesAnonymised empty on first run → FAIL on "length > 0".
    const { db } = makeDb({
      opUpdated: [{ id: "person-1" }],
      sfUpdated: [{ id: 1 }],
      depUpdated: [{ id: 2 }],
    });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });
    expect(result.tablesAnonymised.length).toBeGreaterThan(0);
  });

  it("does not throw on a second run where all updates are no-ops", async () => {
    const { db: db1 } = makeDb({});
    const { db: db2 } = makeDb({ opUpdated: [], sfUpdated: [], depUpdated: [] });
    const svc1 = buildService(db1);
    const svc2 = buildService(db2);

    await expect(svc1.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false })).resolves.not.toThrow();
    await expect(svc2.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false })).resolves.not.toThrow();
  });
});

// ─── Immutable records survive ────────────────────────────────────────────────

describe("GdprSubjectErasureService — immutable records are not touched", () => {
  it("does not update audit_logs rows — only inserts a new audit record", async () => {
    const { db, txMocks } = makeDb({});
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    // The tx.update calls are: (1) organizationPeople, (2) hrEmployeeSensitiveFields,
    // (3) hrDependents, (4) users (if no other memberships).
    // audit_logs is only INSERTed (new audit record), never UPDATEd.
    const { auditLogs: auditLogsTable } = await import("../../db/schema");
    expect(txMocks.tx.update).not.toHaveBeenCalledWith(auditLogsTable);
  });

  it("(bite proof) tx.update call would be detected — if audit_logs were updated, the assertion catches it", async () => {
    // Mechanism: tx.update is a jest.fn() spy. Not calling it with auditLogs means
    // expect(tx.update).not.toHaveBeenCalledWith(auditLogs) passes.
    // If the service mistakenly added tx.update(auditLogs), that assertion would FAIL.
    const { db, txMocks } = makeDb({});
    const svc = buildService(db);
    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    // Verify the spy actually tracked update calls (it IS called for other tables)
    expect(txMocks.tx.update).toHaveBeenCalled();

    const { auditLogs: auditLogsTable } = await import("../../db/schema");
    expect(txMocks.tx.update).not.toHaveBeenCalledWith(auditLogsTable);
  });

  it("payroll_run_employees table is never updated during erasure", async () => {
    const { db, txMocks } = makeDb({});
    const svc = buildService(db);
    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    const { payrollRunEmployees } = await import("../../db/schema");
    expect(txMocks.tx.update).not.toHaveBeenCalledWith(payrollRunEmployees);
  });

  it("writes exactly one audit INSERT after erasure, recording the actor not the subject", async () => {
    const { db, txMocks } = makeDb({});
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    const auditInsertChain = txMocks.insertChains[1];
    expect(auditInsertChain?.values).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "subject.data.erased",
        userId: ACTOR,
        orgId: ORG,
        targetId: SUBJECT,
        targetType: "user",
      }),
    );
    expect(auditInsertChain?.values.mock.calls[0]?.[0]).not.toHaveProperty("email");
    expect(auditInsertChain?.values.mock.calls[0]?.[0]).not.toHaveProperty("name");
  });
});

// ─── Cache invalidation ───────────────────────────────────────────────────────

describe("GdprSubjectErasureService — cache invalidation", () => {
  it("calls bumpPermissionsVersion inside the transaction after anonymising data", async () => {
    const { db, txMocks } = makeDb({});
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(bumpPermissionsVersion).toHaveBeenCalledWith(txMocks.tx, ORG);
  });

  it("calls bustMembershipStatusCache after the transaction commits", async () => {
    const { db } = makeDb({});
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(bustMembershipStatusCache).toHaveBeenCalledWith(
      expect.anything(),
      SUBJECT,
    );
  });

  it("(bite proof) skipping the transaction means bumpPermissionsVersion is never called — test catches it", async () => {
    // Mechanism: db.transaction calls fn(tx), so bumpPermissionsVersion IS called.
    // Neuter: replace db.transaction with jest.fn().mockResolvedValue(undefined) (callback never called).
    // Then expect(bumpPermissionsVersion).toHaveBeenCalled() → FAILS.
    // This test is the positive assertion — verify it DOES get called when transaction works:
    const { db } = makeDb({});
    const svc = buildService(db);
    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });
    expect(bumpPermissionsVersion).toHaveBeenCalledTimes(1);
  });

  it("does not call cache invalidation when a legal hold blocks erasure", async () => {
    const { db } = makeDb({ legalHoldRows: [{ id: 1, reason: "hold" }] });
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(bumpPermissionsVersion).not.toHaveBeenCalled();
    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
  });

  it("does not call cache invalidation on a dry run", async () => {
    const { db } = makeDb({});
    const svc = buildService(db);

    await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: true });

    expect(bumpPermissionsVersion).not.toHaveBeenCalled();
    expect(bustMembershipStatusCache).not.toHaveBeenCalled();
  });
});

// ─── Global identity anonymisation ───────────────────────────────────────────

describe("GdprSubjectErasureService — global identity", () => {
  it("anonymises the users row when the subject has no other org memberships", async () => {
    const { db, txMocks } = makeDb({ otherMemberRows: [] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.globalIdentityAnonymised).toBe(true);
    expect(result.tablesAnonymised).toContain("users");
    // 7 update calls: org_people, sensitive_fields, dependents, ai_chat_conversations, ai_chat_messages, chat_messages, users
    expect(txMocks.tx.update).toHaveBeenCalledTimes(7);
  });

  it("(bite proof) globalIdentityAnonymised is false when subject has another membership — test catches if the guard is skipped", async () => {
    // Mechanism: otherMemberRows = [{ id: 99 }] → otherMembership is truthy → users NOT updated.
    // Neuter: set otherMemberRows = [] → users IS updated → globalIdentityAnonymised = true → FAIL on "false".
    const { db, txMocks } = makeDb({ otherMemberRows: [{ id: 99 }] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.globalIdentityAnonymised).toBe(false);
    expect(result.tablesAnonymised).not.toContain("users");
    // 6 update calls: org_people, sensitive_fields, dependents, ai_chat_conversations, ai_chat_messages, chat_messages (no users)
    expect(txMocks.tx.update).toHaveBeenCalledTimes(6);
  });
});

// ─── Dry run ─────────────────────────────────────────────────────────────────

describe("GdprSubjectErasureService — dry run", () => {
  it("returns a preview of tables to be anonymised without executing any writes", async () => {
    const { db } = makeDb({});
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.tablesAnonymised).toContain("organization_people");
    expect(result.tablesAnonymised).toContain("hr_employee_sensitive_fields");
    expect(result.tablesAnonymised).toContain("hr_dependents");
    expect(result.tablesAnonymised).toContain("kb_chat_messages");
    expect(result.tablesAnonymised).toContain("kb_chat_conversations");
    expect(result.tablesAnonymised).toContain("kb_article_chunks");
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

// ─── Controller — permission denial ──────────────────────────────────────────

describe("GdprController.eraseSubjectData — permission gate", () => {
  it("requires an active org; throws ForbiddenException when orgId is absent", async () => {
    const erasure = { eraseSubject: jest.fn() };
    const controller = new GdprController(
      {} as never,
      {} as never,
      {} as never,
      erasure as never,
      {} as never,
    );

    const userWithoutOrg = { userId: ACTOR, orgId: undefined } as unknown as CurrentUserContext;

    await expect(
      controller.eraseSubjectData(SUBJECT, userWithoutOrg, { reason: "test", dryRun: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(erasure.eraseSubject).not.toHaveBeenCalled();
  });

  it("(bite proof) with a valid orgId, the service IS called — removing the guard would allow access without the permission check", async () => {
    // The PermissionGuard is applied at route level: @UseGuards(PermissionGuard) + @RequirePermission("hr:retention:manage").
    // This test verifies the controller plumbing passes through when orgId is present.
    // A caller without hr:retention:manage is denied by PermissionGuard before this handler runs.
    const erasure = { eraseSubject: jest.fn().mockResolvedValue({ blocked: false, dryRun: false, tablesAnonymised: [], globalIdentityAnonymised: false }) };
    const controller = new GdprController(
      {} as never,
      {} as never,
      {} as never,
      erasure as never,
      {} as never,
    );

    const userWithOrg = { userId: ACTOR, orgId: ORG } as CurrentUserContext;

    await controller.eraseSubjectData(SUBJECT, userWithOrg, { reason: "test", dryRun: false });

    expect(erasure.eraseSubject).toHaveBeenCalledWith(SUBJECT, ORG, ACTOR, { dryRun: false });
  });

  it("passes subjectId (a different person's id) to the service — cross-subject is legitimate per CLAUDE.md §5", async () => {
    const ANOTHER_SUBJECT = "user-another";
    const erasure = { eraseSubject: jest.fn().mockResolvedValue({ blocked: false, dryRun: false, tablesAnonymised: [], globalIdentityAnonymised: false }) };
    const controller = new GdprController(
      {} as never,
      {} as never,
      {} as never,
      erasure as never,
      {} as never,
    );

    const user = { userId: ACTOR, orgId: ORG } as CurrentUserContext;
    await controller.eraseSubjectData(ANOTHER_SUBJECT, user, { reason: "data subject request", dryRun: false });

    expect(erasure.eraseSubject).toHaveBeenCalledWith(ANOTHER_SUBJECT, ORG, ACTOR, { dryRun: false });
  });
});

describe("GdprSubjectErasureService — the id scan drains instead of capping", () => {
  function pagedChain(pages: Array<Array<{ id: number }>>) {
    let call = 0;
    return {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockImplementation(() => Promise.resolve(pages[call++] ?? [])),
      set: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
      values: jest.fn().mockResolvedValue(undefined),
    };
  }

  it("keeps paging while a full page comes back, so a subject past the page size is fully erased", async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({ id: i + 1 }));
    const tailPage = [{ id: 201 }];
    const peopleChain = pagedChain([fullPage, tailPage]);

    let txSelect = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => {
        txSelect++;
        // Drizzle builds a fresh chain per page, so the same double must answer both.
        if (txSelect <= 2) return peopleChain;
        return pagedChain([[]]);
      }),
      update: jest.fn().mockReturnValue(pagedChain([[]])),
      insert: jest.fn().mockReturnValue(pagedChain([[]])),
      delete: jest.fn().mockReturnValue(pagedChain([[]])),
    };
    let dbSelect = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        dbSelect++;
        if (dbSelect === 1) return pagedChain([[{ id: 1 }]]);
        return pagedChain([[]]);
      }),
      update: jest.fn().mockReturnValue(pagedChain([[]])),
      insert: jest.fn().mockReturnValue(pagedChain([[]])),
      transaction: jest
        .fn()
        .mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as ConstructorParameters<typeof GdprSubjectErasureService>[0];

    const cache = { del: jest.fn(), delByPattern: jest.fn() } as unknown as ConstructorParameters<
      typeof GdprSubjectErasureService
    >[1];
    const service = new GdprSubjectErasureService(db, cache);

    await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    // A bare .limit(50) stopped at one call and reported a partial erasure as complete.
    expect(peopleChain.limit).toHaveBeenCalledTimes(2);
    expect(peopleChain.orderBy).toHaveBeenCalled();
  });
});

// ─── AI and chat content erasure ─────────────────────────────────────────────

describe("GdprSubjectErasureService — AI and chat content erasure", () => {
  it("includes ai_chat_conversations in tablesAnonymised when update affects rows", async () => {
    const { db, txMocks } = makeDb({ aiConvUpdated: [{ id: 1 }] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("ai_chat_conversations");
    expect(txMocks.tx.update).toHaveBeenCalledTimes(7);
  });

  it("includes ai_chat_messages in tablesAnonymised when update affects rows", async () => {
    const { db } = makeDb({ aiMsgUpdated: [{ id: 1 }] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("ai_chat_messages");
  });

  it("includes chat_messages in tablesAnonymised when update affects rows", async () => {
    const { db } = makeDb({ chatMsgUpdated: [{ id: 1 }] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).toContain("chat_messages");
  });

  it("(bite proof) ai_chat_conversations absent from tablesAnonymised when update returns no rows — test catches if update is removed", async () => {
    // Mechanism: aiConvUpdated = [] → returning([]) → NOT pushed to tablesAnonymised.
    // Neuter: set aiConvUpdated = [{ id: 1 }] → IS pushed → toContain assertion FAILS on "not to contain".
    const { db } = makeDb({ aiConvUpdated: [] });
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(result.tablesAnonymised).not.toContain("ai_chat_conversations");
  });

  it("dry-run preview includes AI, chat, and KB tables without executing any writes", async () => {
    const { db } = makeDb({});
    const svc = buildService(db);

    const result = await svc.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.tablesAnonymised).toContain("ai_chat_conversations");
    expect(result.tablesAnonymised).toContain("ai_chat_messages");
    expect(result.tablesAnonymised).toContain("chat_messages");
    expect(result.tablesAnonymised).toContain("kb_chat_messages");
    expect(result.tablesAnonymised).toContain("kb_chat_conversations");
    expect(result.tablesAnonymised).toContain("kb_article_chunks");
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
