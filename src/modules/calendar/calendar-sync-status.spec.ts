import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { CalendarSyncStatusService } from "./calendar-sync-status.service";

const dialect = new PgDialect();

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const USER_ID = "user-1";
const EVENT_ID = 42;
const CREATOR_MEMBERSHIP = 10;
const OTHER_MEMBERSHIP = 99;

type QueueRow = {
  state: "PENDING" | "IN_FLIGHT" | "PROCESSED" | "FAILED";
  attemptCount: number;
  lastError: string | null;
  operation: "create" | "update" | "delete";
  createdAt: Date;
  processedAt: Date | null;
};

function makeDb(opts: {
  memberRow?: { id: number };
  visibleEvent?: { id: number; createdByMembershipId: number };
  queueRows?: QueueRow[];
  captureVisibilityWhere?: (pred: SQL) => void;
  captureQueueWhere?: (pred: SQL) => void;
  updateReturning?: { id: number }[];
}): Db {
  const { memberRow, visibleEvent, queueRows = [], captureVisibilityWhere, captureQueueWhere, updateReturning = [] } = opts;

  const visibilityLimit = jest.fn().mockResolvedValue(visibleEvent ? [visibleEvent] : []);
  const visibilityWhere = jest.fn().mockImplementation((pred: SQL) => {
    captureVisibilityWhere?.(pred);
    return { limit: visibilityLimit };
  });
  const visibilityLeftJoin = jest.fn().mockReturnValue({ where: visibilityWhere });
  const visibilityFrom = jest.fn().mockReturnValue({ leftJoin: visibilityLeftJoin });

  const queueLimit = jest.fn().mockResolvedValue(queueRows);
  const queueOrderBy = jest.fn().mockReturnValue({ limit: queueLimit });
  const queueWhere = jest.fn().mockImplementation((pred: SQL) => {
    captureQueueWhere?.(pred);
    return { orderBy: queueOrderBy };
  });
  const queueFrom = jest.fn().mockReturnValue({ where: queueWhere });

  let selectCall = 0;
  const select = jest.fn().mockImplementation(() => {
    selectCall++;
    return selectCall === 1 ? { from: visibilityFrom } : { from: queueFrom };
  });

  const returning = jest.fn().mockResolvedValue(updateReturning);
  const updateWhere = jest.fn().mockReturnValue({ returning });
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const update = jest.fn().mockReturnValue({ set: updateSet });

  return {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(memberRow),
      },
    },
    select,
    update,
  } as unknown as Db;
}

beforeEach(() => jest.resetAllMocks());

describe("CalendarSyncStatusService.getSyncStatus — status mappings", () => {
  const baseEvent = { id: EVENT_ID, createdByMembershipId: CREATOR_MEMBERSHIP };
  const baseMember = { id: CREATOR_MEMBERSHIP };

  it("returns not_synced when no queue row exists", async () => {
    const db = makeDb({ memberRow: baseMember, visibleEvent: baseEvent, queueRows: [] });
    const svc = new CalendarSyncStatusService(db);
    const result = await svc.getSyncStatus(OWNER_ORG, USER_ID, EVENT_ID);
    expect(result.status).toBe("not_synced");
    expect(result.retryable).toBe(false);
    expect(result.attemptCount).toBe(0);
    expect(result.operation).toBeNull();
    expect(result.queuedAt).toBeNull();
  });

  it("maps PROCESSED to synced (retryable = false)", async () => {
    const row: QueueRow = { state: "PROCESSED", attemptCount: 1, lastError: null, operation: "create", createdAt: new Date("2024-01-01"), processedAt: new Date("2024-01-02") };
    const db = makeDb({ memberRow: baseMember, visibleEvent: baseEvent, queueRows: [row] });
    const svc = new CalendarSyncStatusService(db);
    const result = await svc.getSyncStatus(OWNER_ORG, USER_ID, EVENT_ID);
    expect(result.status).toBe("synced");
    expect(result.retryable).toBe(false);
    expect(result.processedAt).toBe(new Date("2024-01-02").toISOString());
  });

  it("maps PENDING to pending (retryable = false)", async () => {
    const row: QueueRow = { state: "PENDING", attemptCount: 0, lastError: null, operation: "update", createdAt: new Date("2024-01-01"), processedAt: null };
    const db = makeDb({ memberRow: baseMember, visibleEvent: baseEvent, queueRows: [row] });
    const svc = new CalendarSyncStatusService(db);
    const result = await svc.getSyncStatus(OWNER_ORG, USER_ID, EVENT_ID);
    expect(result.status).toBe("pending");
    expect(result.retryable).toBe(false);
  });

  it("maps IN_FLIGHT to in_flight (retryable = false)", async () => {
    const row: QueueRow = { state: "IN_FLIGHT", attemptCount: 1, lastError: null, operation: "delete", createdAt: new Date("2024-01-01"), processedAt: null };
    const db = makeDb({ memberRow: baseMember, visibleEvent: baseEvent, queueRows: [row] });
    const svc = new CalendarSyncStatusService(db);
    const result = await svc.getSyncStatus(OWNER_ORG, USER_ID, EVENT_ID);
    expect(result.status).toBe("in_flight");
    expect(result.retryable).toBe(false);
  });

  it("maps FAILED to failed (retryable = true)", async () => {
    const row: QueueRow = { state: "FAILED", attemptCount: 5, lastError: "timeout", operation: "create", createdAt: new Date("2024-01-01"), processedAt: null };
    const db = makeDb({ memberRow: baseMember, visibleEvent: baseEvent, queueRows: [row] });
    const svc = new CalendarSyncStatusService(db);
    const result = await svc.getSyncStatus(OWNER_ORG, USER_ID, EVENT_ID);
    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(true);
    expect(result.lastError).toBe("timeout");
    expect(result.attemptCount).toBe(5);
  });
});

describe("CalendarSyncStatusService — invisible / cross-tenant events", () => {
  it("getSyncStatus throws NotFoundException for invisible event (BOLA deny)", async () => {
    const db = makeDb({ memberRow: { id: CREATOR_MEMBERSHIP }, visibleEvent: undefined });
    const svc = new CalendarSyncStatusService(db);
    await expect(svc.getSyncStatus(OWNER_ORG, USER_ID, EVENT_ID)).rejects.toThrow(NotFoundException);
  });

  it("retrySync throws NotFoundException for invisible event (BOLA deny)", async () => {
    const db = makeDb({ memberRow: { id: CREATOR_MEMBERSHIP }, visibleEvent: undefined });
    const svc = new CalendarSyncStatusService(db);
    await expect(svc.retrySync(OWNER_ORG, USER_ID, EVENT_ID)).rejects.toThrow(NotFoundException);
  });

  it("getSyncStatus — visibility predicate binds org_id and ATTACKER org, owner org absent", async () => {
    let capturedWhere: SQL | undefined;
    const db = makeDb({
      memberRow: { id: CREATOR_MEMBERSHIP },
      visibleEvent: undefined,
      captureVisibilityWhere: (pred) => { capturedWhere = pred; },
    });
    const svc = new CalendarSyncStatusService(db);
    await expect(svc.getSyncStatus(ATTACKER_ORG, USER_ID, EVENT_ID)).rejects.toThrow(NotFoundException);
    expect(capturedWhere).toBeDefined();
    const { sql, params } = dialect.sqlToQuery(capturedWhere as SQL);
    expect(sql).toContain("org_id");
    expect(params).toContain(ATTACKER_ORG);
    expect(params).not.toContain(OWNER_ORG);
  });

  it("sync queue query binds org_id and the caller org, owner org absent", async () => {
    let capturedQueueWhere: SQL | undefined;
    const db = makeDb({
      memberRow: { id: CREATOR_MEMBERSHIP },
      visibleEvent: { id: EVENT_ID, createdByMembershipId: CREATOR_MEMBERSHIP },
      queueRows: [],
      captureQueueWhere: (pred) => { capturedQueueWhere = pred; },
    });
    const svc = new CalendarSyncStatusService(db);
    await svc.getSyncStatus(ATTACKER_ORG, USER_ID, EVENT_ID);
    expect(capturedQueueWhere).toBeDefined();
    const { sql, params } = dialect.sqlToQuery(capturedQueueWhere as SQL);
    expect(sql).toContain("org_id");
    expect(params).toContain(ATTACKER_ORG);
    expect(params).not.toContain(OWNER_ORG);
  });
});

describe("CalendarSyncStatusService.retrySync — authorization", () => {
  it("throws NotFoundException when caller is not the event creator", async () => {
    const db = makeDb({
      memberRow: { id: OTHER_MEMBERSHIP },
      visibleEvent: { id: EVENT_ID, createdByMembershipId: CREATOR_MEMBERSHIP },
    });
    const svc = new CalendarSyncStatusService(db);
    await expect(svc.retrySync(OWNER_ORG, USER_ID, EVENT_ID)).rejects.toThrow(NotFoundException);
  });
});

describe("CalendarSyncStatusService.retrySync — row targeting", () => {
  it("resets only FAILED rows; PENDING and PROCESSED rows are untouched (update WHERE scopes to FAILED state)", async () => {
    let capturedUpdateWhere: SQL | undefined;
    const visibilityLimit = jest.fn().mockResolvedValue([{ id: EVENT_ID, createdByMembershipId: CREATOR_MEMBERSHIP }]);
    const visibilityWhere = jest.fn().mockReturnValue({ limit: visibilityLimit });
    const visibilityLeftJoin = jest.fn().mockReturnValue({ where: visibilityWhere });
    const visibilityFrom = jest.fn().mockReturnValue({ leftJoin: visibilityLeftJoin });

    const returning = jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const updateWhere = jest.fn().mockImplementation((pred: SQL) => {
      capturedUpdateWhere = pred;
      return { returning };
    });
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const update = jest.fn().mockReturnValue({ set: updateSet });

    const db = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: CREATOR_MEMBERSHIP }) } },
      select: jest.fn().mockReturnValue({ from: visibilityFrom }),
      update,
    } as unknown as Db;

    const svc = new CalendarSyncStatusService(db);
    const result = await svc.retrySync(OWNER_ORG, USER_ID, EVENT_ID);
    expect(result.requeued).toBe(2);

    expect(capturedUpdateWhere).toBeDefined();
    const { sql, params } = dialect.sqlToQuery(capturedUpdateWhere as SQL);
    expect(sql).toContain("org_id");
    expect(sql).toContain("event_id");
    expect(sql).toContain("state");
    expect(params).toContain(OWNER_ORG);
    expect(params).toContain(EVENT_ID);
    expect(params).toContain("FAILED");
  });

  it("requeued count reflects only the rows that were actually reset", async () => {
    const db = makeDb({
      memberRow: { id: CREATOR_MEMBERSHIP },
      visibleEvent: { id: EVENT_ID, createdByMembershipId: CREATOR_MEMBERSHIP },
      updateReturning: [],
    });
    const svc = new CalendarSyncStatusService(db);
    const result = await svc.retrySync(OWNER_ORG, USER_ID, EVENT_ID);
    expect(result.requeued).toBe(0);
  });
});
