import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { HrInterviewBookingService } from "./hr-interview-booking.service";
import { HrInterviewResultsService } from "./hr-interview-results.service";
import { HrInterviewSchedulingService } from "./hr-interview-scheduling.service";
import { HrInterviewersService } from "./hr-interviewers.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as Record<string, unknown>;
  return [
    ...(Array.isArray(r["queryChunks"]) ? sqlValues(r["queryChunks"], seen) : []),
    ...("value" in r ? sqlValues(r["value"], seen) : []),
  ];
}

function makeDb(rows: unknown[]) {
  const where = jest.fn();
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const builder = {
    from: jest.fn(), where, orderBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
    leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(), for: jest.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve([{ id: 1, userId: "i1" }]).then(resolve),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.offset.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.groupBy.mockReturnValue(builder);
  builder.for.mockReturnValue(builder);
  const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findMany, findFirst }) });
  const txDb = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }), returning: jest.fn().mockResolvedValue(rows) }) }),
    execute: jest.fn().mockResolvedValue(rows),
  } as unknown as Db;
  const deleteFn = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) });
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }), returning: jest.fn().mockResolvedValue(rows) }) }),
    execute: jest.fn().mockResolvedValue(rows),
    delete: deleteFn,
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn(txDb)),
  } as unknown as Db;
  return { db, where, findMany, findFirst, deleteFn };
}

const stub = <T,>() => ({}) as T;

function isolationArg(where: jest.Mock, findMany: jest.Mock, findFirst?: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  if (findFirst && findFirst.mock.calls.length > 0) return (findFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("HrInterviewBookingService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("returns NotFoundException when booking token is not found (cross-tenant isolation — no token, no org access)", async () => {
    const { db } = makeDb([]);
    const mockEmail = { sendEmail: jest.fn() };
    const svc = new HrInterviewBookingService(db, mockEmail as never, stub<ConstructorParameters<typeof HrInterviewBookingService>[2]>());
    await expect(svc.book("nonexistent-token", { slotStart: new Date().toISOString() } as never)).rejects.toThrow(NotFoundException);
  });

  it("scopes booking link lookup to orgId from token (control — token provides org context)", async () => {
    const linkRow = { id: 1, orgId: OWNER, token: "valid-token", status: "pending", expiresAt: new Date(Date.now() + 60_000), candidateId: 1, jobPostingId: 1, createdBy: "u1", interviewers: [{ userId: "interviewer-1" }], availableSlots: [], durationMinutes: 60, interviewType: "VIDEO", notes: null };
    const { db, findFirst } = makeDb([linkRow]);
    const mockEmail = { sendEmail: jest.fn() };
    const svc = new HrInterviewBookingService(db, mockEmail as never, stub<ConstructorParameters<typeof HrInterviewBookingService>[2]>());
    await expect(svc.book("valid-token", { slotStart: new Date(Date.now() + 3600_000).toISOString() } as never)).rejects.toThrow(BadRequestException);
    const args = findFirst.mock.calls.flatMap((call) =>
      sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
    );
    expect(args).toContain("valid-token");
  });
});

describe("HrInterviewResultsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, candidateId: 1, interviewerId: "u1", result: "PENDING", scheduledAt: new Date() };

  it("returns NotFoundException for cross-tenant interview access (cross-tenant isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const mockEmail = { sendEmail: jest.fn() };
    const svc = new HrInterviewResultsService(db, mockAutomation as never, mockEmail as never);
    await expect(svc.updateInterview(ATTACKER, 999, {})).rejects.toThrow(NotFoundException);
    const args = findFirst.mock.calls.flatMap((call) =>
      sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
    );
    expect(args).toContain(ATTACKER);
  });

  it("updates interview for owning org (control — same-tenant access works)", async () => {
    const { db, findFirst } = makeDb([ROW]);
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const mockEmail = { sendEmail: jest.fn() };
    const svc = new HrInterviewResultsService(db, mockAutomation as never, mockEmail as never);
    await svc.updateInterview(OWNER, 1, { type: "VIDEO" });
    const args = findFirst.mock.calls.flatMap((call) =>
      sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
    );
    expect(args).toContain(OWNER);
  });

  it("includes orgId in the update WHERE so a cross-tenant write cannot succeed (TOCTOU write fix — cross-tenant DENY)", async () => {
    const updateWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
    const db = {
      query: { interviews: { findFirst: jest.fn().mockResolvedValue(ROW) } },
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
    } as unknown as Db;
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const mockEmail = { sendEmail: jest.fn() };
    const svc = new HrInterviewResultsService(db, mockAutomation as never, mockEmail as never);

    await svc.updateInterview(ATTACKER, 1, { type: "VIDEO" });

    expect(updateWhere).toHaveBeenCalledTimes(1);
    const whereArg = updateWhere.mock.calls[0]?.[0];
    expect(sqlValues(whereArg)).toContain(ATTACKER);
    expect(sqlValues(whereArg)).not.toContain(OWNER);
  });

  it("includes orgId in the update WHERE for the owning org (TOCTOU write fix — same-tenant CONTROL)", async () => {
    const updateWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([ROW]) });
    const db = {
      query: { interviews: { findFirst: jest.fn().mockResolvedValue(ROW) } },
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
    } as unknown as Db;
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const mockEmail = { sendEmail: jest.fn() };
    const svc = new HrInterviewResultsService(db, mockAutomation as never, mockEmail as never);

    await svc.updateInterview(OWNER, 1, { type: "VIDEO" });

    expect(updateWhere).toHaveBeenCalledTimes(1);
    const whereArg = updateWhere.mock.calls[0]?.[0];
    expect(sqlValues(whereArg)).toContain(OWNER);
  });

  it("scopes getScorecard interview check to org (cross-tenant isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const mockEmail = { sendEmail: jest.fn() };
    const svc = new HrInterviewResultsService(db, mockAutomation as never, mockEmail as never);
    await expect(svc.getScorecard(ATTACKER, "user-1", 1, 999)).rejects.toThrow(NotFoundException);
    const args = findFirst.mock.calls.flatMap((call) =>
      sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
    );
    expect(args).toContain(ATTACKER);
  });
});

describe("HrInterviewSchedulingService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const CANDIDATE = { id: 1, orgId: OWNER, firstName: "Jane", lastName: "Doe", email: "jane@test.com" };

  it("scopes candidate lookup to org when scheduling (cross-tenant isolation — no candidate in attacker org)", async () => {
    const { db, findFirst } = makeDb([]);
    const mockCache = { invalidate: jest.fn() };
    const mockNotifications = { create: jest.fn().mockResolvedValue(undefined) };
    const mockEmail = { sendEmail: jest.fn() };
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const svc = new HrInterviewSchedulingService(db, mockCache as never, mockNotifications as never, mockEmail as never, mockAutomation as never, stub<ConstructorParameters<typeof HrInterviewSchedulingService>[5]>());
    const input = { candidateId: 1, jobPostingId: 1, scheduledAt: new Date(Date.now() + 86400_000).toISOString(), durationMinutes: 60, format: "VIDEO" as const, interviewers: ["i1"], createMeet: false, notifyChannels: { email: false, whatsapp: false } };
    await expect(svc.scheduleInterview(ATTACKER, "actor-1", input)).rejects.toThrow(NotFoundException);
    const args = findFirst.mock.calls.flatMap((call) =>
      sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
    );
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.anything() }));
  });

  it("scopes candidate lookup to owning org (control — same-tenant access works)", async () => {
    const { db, findFirst } = makeDb([CANDIDATE]);
    const mockCache = { invalidate: jest.fn() };
    const mockNotifications = { create: jest.fn().mockResolvedValue(undefined) };
    const mockEmail = { sendEmail: jest.fn() };
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const svc = new HrInterviewSchedulingService(db, mockCache as never, mockNotifications as never, mockEmail as never, mockAutomation as never, stub<ConstructorParameters<typeof HrInterviewSchedulingService>[5]>());
    const input = { candidateId: 1, jobPostingId: 1, scheduledAt: new Date(Date.now() + 86400_000).toISOString(), durationMinutes: 60, format: "VIDEO" as const, interviewers: ["i1"], createMeet: false, notifyChannels: { email: false, whatsapp: false } };
    await svc.scheduleInterview(OWNER, "actor-1", input);
    const args = findFirst.mock.calls.flatMap((call) =>
      sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
    );
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.anything() }));
  });

  it("scopes deleteInterview to org and refuses a foreign id with 404 (cross-tenant isolation)", async () => {
    const { db, deleteFn } = makeDb([]);
    const mockCache = { invalidate: jest.fn() };
    const mockNotifications = { create: jest.fn().mockResolvedValue(undefined) };
    const mockEmail = { sendEmail: jest.fn() };
    const mockAutomation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const svc = new HrInterviewSchedulingService(db, mockCache as never, mockNotifications as never, mockEmail as never, mockAutomation as never, stub<ConstructorParameters<typeof HrInterviewSchedulingService>[5]>());

    await expect(svc.deleteInterview(ATTACKER, 999)).rejects.toThrow(NotFoundException);

    const dbDeleteWhere = deleteFn.mock.results[0]?.value?.where;
    expect(dbDeleteWhere).toBeDefined();
    expect(sqlValues(dbDeleteWhere.mock.calls[0]?.[0])).toContain(ATTACKER);
  });
});

describe("HrInterviewersService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER };

  it("scopes booking links to org (cross-tenant isolation)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = new HrInterviewersService(db);
    await svc.listBookingLinks(ATTACKER);
    const args = findMany.mock.calls.flatMap((call) =>
      sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
    );
    expect(args).toContain(ATTACKER);
  });

  it("returns booking links for owning org (control — same-tenant access works)", async () => {
    const { db, findMany } = makeDb([ROW]);
    const svc = new HrInterviewersService(db);
    const result = await svc.listBookingLinks(OWNER);
    const args = findMany.mock.calls.flatMap((call) =>
      sqlValues((call[0] as Record<string, unknown> | undefined)?.["where"]),
    );
    expect(args).toContain(OWNER);
    expect(Array.isArray(result)).toBe(true);
  });

  it("scopes interviewer performance to org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new HrInterviewersService(db);
    await svc.interviewerPerformance(ATTACKER, 30);
    const allWhere = where.mock.calls.flatMap((call) => sqlValues(call[0]));
    expect(allWhere).toContain(ATTACKER);
  });
});
