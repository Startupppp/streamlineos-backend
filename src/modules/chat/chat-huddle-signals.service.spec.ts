import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ChatHuddleSignalsService } from "./chat-huddle-signals.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const dialect = new PgDialect();

function renderWhere(where: unknown): string {
  return dialect.sqlToQuery(where as SQL).sql;
}

const mockDb = {
  query: {
    chatHuddles: { findFirst: jest.fn() },
    organizationMembers: { findFirst: jest.fn() },
  },
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue([]),
};

/**
 * The heartbeat is what is left of the old signalling surface, and it is deliberately left.
 *
 * The call itself happens at Google Meet, which reports nothing back, so `last_seen_at` is the
 * only evidence a participant is still there — `reapStaleHuddleParticipants` closes a row that
 * has not been touched in 90s and `getActiveHuddle` ends a huddle once the last row closes.
 * Without it a closed tab would hold the huddle open for the full 12-hour ceiling.
 */
describe("ChatHuddleSignalsService.heartbeat", () => {
  let service: ChatHuddleSignalsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatHuddleSignalsService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(ChatHuddleSignalsService);
  });

  it("throws NotFoundException when the huddle is not in the caller's org", async () => {
    mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
    await expect(service.heartbeat(1, "user1", "org1")).rejects.toThrow(NotFoundException);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("throws ForbiddenException when the huddle exists but the caller has no membership", async () => {
    mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1 });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
    await expect(service.heartbeat(1, "user1", "org1")).rejects.toThrow(ForbiddenException);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("returns ok:true for a huddle in the caller's org (control)", async () => {
    mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1 });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 5 });
    await expect(service.heartbeat(1, "user1", "org1")).resolves.toEqual({ ok: true });
  });

  it("stamps last_seen_at, which is the column the stale-participant reap reads", async () => {
    mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1 });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 5 });

    await service.heartbeat(42, "user1", "org1");

    expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ lastSeenAt: expect.anything() }));
  });

  it("writes only the caller's own still-open row in the caller's own org", async () => {
    mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1 });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 5 });

    await service.heartbeat(42, "user1", "org1");

    const [where] = mockDb.where.mock.calls[0] ?? [];
    const sql = renderWhere(where);
    expect(sql).toContain('"chat_huddle_participants"."org_id" =');
    expect(sql).toContain('"chat_huddle_participants"."huddle_id" =');
    expect(sql).toContain('"chat_huddle_participants"."membership_id" =');
    expect(sql).toContain('"chat_huddle_participants"."left_at" is null');
  });
});
