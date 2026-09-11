jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import { ChatHuddlesService } from "./chat-huddles.service";
import { HUDDLE_PARTICIPANT_CEILING } from "./chat-huddle-capacity";
import {
  HUDDLE_MEETING_NEEDS_REAUTH,
  HUDDLE_MEETING_NO_CONNECTION,
  HUDDLE_MEETING_NO_LINK,
  HUDDLE_MEETING_PROVIDER_FAILED,
  HUDDLE_MEETING_UNCONFIGURED,
} from "./chat-huddle-meeting";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AblyService } from "../realtime/ably.service";
import { AuditService } from "../../common/audit/audit.service";
import { ComposioGateway, ComposioToolError } from "../integrations/core/composio.gateway";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { primeRelocationTrafficTracker } from "../../common/relocation/relocation-traffic-tracker";
import { calendarEvents, chatHuddles, userIntegrationConnections } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

const mockDb = {
  query: {
    chatHuddles: { findFirst: jest.fn() },
    chatChannelMembers: { findFirst: jest.fn(), findMany: jest.fn() },
    chatHuddleParticipants: { findMany: jest.fn() },
    chatChannels: { findFirst: jest.fn() },
    organizationMembers: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, channelId: 1, startedByMembershipId: 1, status: "active", calendarEventId: null, meetingUrl: null, startedAt: new Date(), endedAt: null }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue([]),
  transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  onConflictDoUpdate: jest.fn().mockResolvedValue([]),
};

const mockAbly = { publishHuddleEvent: jest.fn().mockResolvedValue(undefined), publishToUser: jest.fn().mockResolvedValue(undefined) };
const mockDispatch = { emit: jest.fn().mockResolvedValue({ eventKey: "chat.huddle.invite", notified: 0, deliveriesQueued: 0, suppressed: 0, deduped: 0, deferred: true }) };
const mockAudit = { log: jest.fn() };
const mockOrgSettings = {
  getSettings: jest.fn().mockResolvedValue({ maxHuddleParticipants: 50 }),
};
const mockPlanLimits = {
  resolveTier: jest.fn().mockResolvedValue({ tier: "PAID", plan: "STARTER" }),
};
const mockComposio = { isConfigured: jest.fn().mockReturnValue(true), executeTool: jest.fn() };

describe("ChatHuddlesService", () => {
  let service: ChatHuddlesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
    mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 50 });
    mockPlanLimits.resolveTier.mockResolvedValue({ tier: "PAID", plan: "STARTER" });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatHuddlesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AblyService, useValue: mockAbly },
        { provide: NotificationDispatchService, useValue: mockDispatch },
        { provide: AuditService, useValue: mockAudit },
        { provide: ChatOrgSettingsService, useValue: mockOrgSettings },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: ComposioGateway, useValue: mockComposio },
      ],
    }).compile();
    service = module.get(ChatHuddlesService);
  });

  describe("assertMember", () => {
    it("throws ForbiddenException if not member", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue(null);
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      await expect(service["assertMember"](1, "user1", "org1")).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException if org membership is not active (departed member)", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      await expect(service["assertMember"](1, "user1", "org1")).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException if channel is archived", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: true });
      await expect(service["assertMember"](1, "user1", "org1")).rejects.toThrow(ForbiddenException);
    });

    it("returns the membershipId when valid", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      const result = await service["assertMember"](1, "user1", "org1");
      expect(result).toBe(1);
    });
  });

  describe("leaveHuddle", () => {
    it("throws NotFoundException if huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.leaveHuddle(1, "user1", "org1")).rejects.toThrow(NotFoundException);
    });

    it("ends huddle when last participant leaves", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedByMembershipId: 1, calendarEventId: null });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([]);
      await service.leaveHuddle(1, "user1", "org1");
      expect(mockAbly.publishHuddleEvent).toHaveBeenCalledWith("org1", 1, "huddle:ended", expect.any(Object));
    });

    it("transfers host to next participant when host leaves with others remaining", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedByMembershipId: 1, calendarEventId: null });
      mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([{ membershipId: 2 }]);
      await service.leaveHuddle(1, "user1", "org1");
      expect(mockAbly.publishHuddleEvent).toHaveBeenCalledWith(
        "org1", 1, "huddle:state_updated",
        expect.objectContaining({ hostTransferred: true, newHostMembershipId: 2 }),
      );
    });

    it("does not transfer host when a non-host leaves with others remaining", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedByMembershipId: 99, calendarEventId: null });
      mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([{ membershipId: 99 }]);
      await service.leaveHuddle(1, "user1", "org1");
      expect(mockAbly.publishHuddleEvent).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), "huddle:state_updated",
        expect.objectContaining({ hostTransferred: true }),
      );
    });
  });

  describe("kickParticipant", () => {
    it("throws NotFoundException if huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.kickParticipant(1, "user1", "user2", "org1")).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException when non-host tries to kick (startedByMembershipId !== callerMembershipId)", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedByMembershipId: 99 });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      await expect(service.kickParticipant(1, "user1", "user2", "org1")).rejects.toThrow(ForbiddenException);
    });

    it("allows host to kick a participant (startedByMembershipId === callerMembershipId)", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedByMembershipId: 1 });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.organizationMembers.findFirst
        .mockResolvedValueOnce({ id: 1 })
        .mockResolvedValueOnce({ id: 2 });
      const result = await service.kickParticipant(1, "user1", "user2", "org1");
      expect(result).toEqual({ ok: true });
      expect(mockAbly.publishHuddleEvent).toHaveBeenCalledWith("org1", 1, "huddle:state_updated", expect.objectContaining({ kicked: true }));
    });
  });

  describe("joinHuddle", () => {
    it("sizes the participant read to the org's own cap plus a sentinel, not a transport constant", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([{ membershipId: 2 }]);
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 50 });

      await service.joinHuddle(1, "user2", "org1");

      expect(mockDb.query.chatHuddleParticipants.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 51 }),
      );
    });

    it("throws NotFoundException if huddle not found or inactive", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.joinHuddle(1, "user1", "org1")).rejects.toThrow(NotFoundException);
    });

    it("rejects joining once the org's max participant cap is reached", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([
        { membershipId: 2 },
        { membershipId: 3 },
      ]);
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 2 });
      await expect(service.joinHuddle(1, "user2", "org1")).rejects.toThrow(
        new ForbiddenException("This call is full (max 2 participants)"),
      );
    });

    it("allows a participant already in the call to rejoin even when the cap is reached", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([{ membershipId: 1 }]);
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 1 });
      const result = await service.joinHuddle(1, "user1", "org1");
      expect(result).toEqual({ ok: true });
    });

    it("allows joining when under the cap", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([{ membershipId: 2 }]);
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 50 });
      const result = await service.joinHuddle(1, "user2", "org1");
      expect(result).toEqual({ ok: true });
    });

    it("FREE plan: third join throws ForbiddenException with upgrade message", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "FREE", plan: "FREE" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([
        { membershipId: 2 },
        { membershipId: 3 },
      ]);
      await expect(service.joinHuddle(1, "user3", "org1")).rejects.toThrow(
        new ForbiddenException("Huddles are one-to-one on the Free plan. Upgrade to start group huddles."),
      );
    });

    it("FREE plan: the 1:1 gate holds even when the org sets a cap of 500", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "FREE", plan: "FREE" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([
        { membershipId: 2 },
        { membershipId: 3 },
      ]);
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: HUDDLE_PARTICIPANT_CEILING });
      await expect(service.joinHuddle(1, "user3", "org1")).rejects.toThrow(
        new ForbiddenException("Huddles are one-to-one on the Free plan. Upgrade to start group huddles."),
      );
      expect(mockDb.query.chatHuddleParticipants.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 3 }),
      );
    });

    it("PAID plan: the org setting is now the operative cap — 12 is reachable and 12 is full", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "PAID", plan: "STARTER" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 12 });

      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue(
        Array.from({ length: 11 }, (_, i) => ({ membershipId: i + 2 })),
      );
      await expect(service.joinHuddle(1, "newUser", "org1")).resolves.toEqual({ ok: true });

      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue(
        Array.from({ length: 12 }, (_, i) => ({ membershipId: i + 2 })),
      );
      await expect(service.joinHuddle(1, "newUser", "org1")).rejects.toThrow(
        new ForbiddenException("This call is full (max 12 participants)"),
      );
    });

    it("clamps an out-of-band org setting to the 2..500 band the settings schema validates", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "PAID", plan: "STARTER" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 10_000 });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue(
        Array.from({ length: HUDDLE_PARTICIPANT_CEILING }, (_, i) => ({ membershipId: i + 2 })),
      );

      await expect(service.joinHuddle(1, "newUser", "org1")).rejects.toThrow(
        new ForbiddenException(`This call is full (max ${HUDDLE_PARTICIPANT_CEILING} participants)`),
      );
      expect(mockDb.query.chatHuddleParticipants.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: HUDDLE_PARTICIPANT_CEILING + 1 }),
      );
    });
  });

  describe("inviteToHuddle", () => {
    it("limits the free-plan participant check to the threshold sentinel", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "FREE", plan: "FREE" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([{ id: 1 }]);

      await service.inviteToHuddle(1, "user1", "org1", ["user3"]);

      expect(mockDb.query.chatHuddleParticipants.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 3 }),
      );
    });

    it("throws NotFoundException if huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.inviteToHuddle(1, "user1", "org1", ["user2"])).rejects.toThrow(NotFoundException);
    });

    it("FREE plan: invite when 2 active participants throws ForbiddenException", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "FREE", plan: "FREE" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([
        { id: 1 },
        { id: 2 },
      ]);
      await expect(service.inviteToHuddle(1, "user1", "org1", ["user3"])).rejects.toThrow(
        new ForbiddenException("Huddles are one-to-one on the Free plan. Upgrade to start group huddles."),
      );
    });

    it("PAID plan: invite proceeds regardless of participant count", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "PAID", plan: "STARTER" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      const result = await service.inviteToHuddle(1, "user1", "org1", ["user3"]);
      expect(result).toEqual({ ok: true });
      expect(mockAbly.publishToUser).toHaveBeenCalledWith("org1", "user3", "notification:huddle_invite", expect.any(Object));
    });
  });
});

/**
 * Starting a huddle mints its Google Meet link first and writes the huddle only after.
 *
 * The double answers the real relational and builder calls the start path makes, and the
 * outcome of each case follows from the ROWS it returns — `resolveToolkitConnection` and
 * `mintHuddleMeetingUrl` are the production functions throughout, never a stub told to reject.
 * `@composio/core` is mocked at the top of this file: `COMPOSIO_API_KEY` is live in `.env` and a
 * real gateway here would create Google events on somebody's actual calendar.
 */
describe("ChatHuddlesService.startHuddle — the Meet link is the transport", () => {
  const ORG = "org-1";
  const CHANNEL = 7;
  const ME = "user-me";
  const MEET = "https://meet.google.com/abc-defg-hij";

  const ACTIVE_ORG_CONNECTION = {
    connectionId: 3,
    composioConnectedAccountId: "ca_shared",
    composioUserId: `org:${ORG}`,
    scope: "org",
    status: "active",
    accountEmail: "workspace@example.com",
  };

  interface Insert {
    table: unknown;
    values: unknown;
  }

  /**
   * The status AND the message, because `toThrow(new SomeException(msg))` compares only the
   * message — it would pass with every refusal collapsed back onto one code.
   */
  async function refusal(started: Promise<unknown>): Promise<{ status: number; message: string }> {
    let resolved = false;
    try {
      await started;
      resolved = true;
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return { status: error.getStatus(), message: error.message };
    }
    if (resolved) throw new Error("startHuddle resolved where a refusal was expected");
    throw new Error("unreachable");
  }

  /** Phase three never ran: no huddle row, no calendar event, nothing to clean up. */
  function expectNothingStarted(inserts: readonly Insert[]): void {
    expect(inserts.find((i) => i.table === chatHuddles)).toBeUndefined();
    expect(inserts.find((i) => i.table === calendarEvents)).toBeUndefined();
  }

  function makeStartDb(connectionRows: readonly unknown[]) {
    const inserts: Insert[] = [];
    let lastInsertTable: unknown = null;
    let lastFromTable: unknown = null;

    const chain: Record<string, unknown> = {};
    for (const method of ["update", "set", "delete", "innerJoin", "orderBy"])
      chain[method] = jest.fn(() => chain);
    chain.insert = jest.fn((table: unknown) => {
      lastInsertTable = table;
      return chain;
    });
    chain.values = jest.fn((values: unknown) => {
      inserts.push({ table: lastInsertTable, values });
      return chain;
    });
    chain.select = jest.fn(() => chain);
    chain.from = jest.fn((table: unknown) => {
      lastFromTable = table;
      return chain;
    });
    chain.where = jest.fn(() => chain);
    chain.limit = jest.fn(() =>
      Promise.resolve(lastFromTable === userIntegrationConnections ? [...connectionRows] : []),
    );
    chain.onConflictDoNothing = jest.fn(() => Promise.resolve([]));
    chain.onConflictDoUpdate = jest.fn(() => Promise.resolve([]));
    chain.returning = jest.fn(() =>
      Promise.resolve([
        { id: 99, channelId: CHANNEL, startedByMembershipId: 1, status: "active", calendarEventId: 5, meetingUrl: MEET },
      ]),
    );
    chain.execute = jest.fn(() => Promise.resolve([]));
    chain.transaction = jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb(chain));
    chain.query = {
      chatHuddles: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockResolvedValue({
            id: 99,
            channelId: CHANNEL,
            status: "active",
            calendarEventId: 5,
            meetingUrl: MEET,
            startedAt: new Date("2026-09-09T10:00:00Z"),
            endedAt: null,
            participants: [],
            startedByMembership: { userId: ME, user: { id: ME, name: "Me" } },
          }),
      },
      chatChannels: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ isArchived: false })
          .mockResolvedValue({ name: "general" }),
      },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ membershipId: 1 }) },
      chatHuddleParticipants: { findMany: jest.fn().mockResolvedValue([]) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
    };
    return { db: chain as unknown as Db, inserts };
  }

  function build(db: Db, composio: { isConfigured(): boolean; executeTool: jest.Mock }) {
    return new ChatHuddlesService(
      db,
      { publishHuddleEvent: jest.fn(), publishToUser: jest.fn() } as never,
      { log: jest.fn() } as never,
      { getSettings: jest.fn().mockResolvedValue({ maxHuddleParticipants: 50 }) } as never,
      { resolveTier: jest.fn().mockResolvedValue({ tier: "PAID", plan: "STARTER" }) } as never,
      { emit: jest.fn().mockResolvedValue({}) } as never,
      composio as never,
    );
  }

  function gateway(overrides: Partial<{ isConfigured: boolean; execute: jest.Mock }> = {}) {
    return {
      isConfigured: () => overrides.isConfigured ?? true,
      executeTool:
        overrides.execute ??
        jest.fn().mockResolvedValue({ response_data: { id: "gcal-1", hangoutLink: MEET } }),
    };
  }

  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("mints a Meet link and persists it on the huddle and on its calendar event", async () => {
    const { db, inserts } = makeStartDb([ACTIVE_ORG_CONNECTION]);
    const composio = gateway();

    const started = await build(db, composio).startHuddle(CHANNEL, ME, ORG);

    expect(started?.meetingUrl).toBe(MEET);
    const huddleInsert = inserts.find((i) => i.table === chatHuddles);
    expect(huddleInsert?.values).toEqual(expect.objectContaining({ meetingUrl: MEET }));
    const eventInsert = inserts.find((i) => i.table === calendarEvents);
    expect(eventInsert?.values).toEqual(expect.objectContaining({ meetingUrl: MEET }));
  });

  it("asks Composio under the connection's own principal, not the starter's user id", async () => {
    const { db } = makeStartDb([ACTIVE_ORG_CONNECTION]);
    const composio = gateway();

    await build(db, composio).startHuddle(CHANNEL, ME, ORG);

    expect(composio.executeTool).toHaveBeenCalledWith(
      "GOOGLECALENDAR_CREATE_EVENT",
      `org:${ORG}`,
      expect.objectContaining({ create_meeting_room: true }),
      "ca_shared",
    );
    expect(composio.executeTool).not.toHaveBeenCalledWith(
      expect.anything(),
      ME,
      expect.anything(),
      expect.anything(),
    );
  });

  it("412, not 503, when the org has no connection: no retry can fix org state", async () => {
    const { db, inserts } = makeStartDb([]);
    const composio = gateway();

    await expect(refusal(build(db, composio).startHuddle(CHANNEL, ME, ORG))).resolves.toEqual({
      status: HttpStatus.PRECONDITION_FAILED,
      message: HUDDLE_MEETING_NO_CONNECTION,
    });
    expect(composio.executeTool).not.toHaveBeenCalled();
    expectNothingStarted(inserts);
  });

  it("412 when the only connection rows are inactive, and the message says reconnect", async () => {
    const { db, inserts } = makeStartDb([{ ...ACTIVE_ORG_CONNECTION, status: "expired" }]);

    await expect(refusal(build(db, gateway()).startHuddle(CHANNEL, ME, ORG))).resolves.toEqual({
      status: HttpStatus.PRECONDITION_FAILED,
      message: HUDDLE_MEETING_NEEDS_REAUTH,
    });
    expectNothingStarted(inserts);
  });

  it("412 when Google rejects the stored token, because the remedy is a reconnect not a retry", async () => {
    const { db, inserts } = makeStartDb([ACTIVE_ORG_CONNECTION]);
    const composio = gateway({
      execute: jest.fn().mockRejectedValue(new ComposioToolError("invalid_grant", true)),
    });

    await expect(refusal(build(db, composio).startHuddle(CHANNEL, ME, ORG))).resolves.toEqual({
      status: HttpStatus.PRECONDITION_FAILED,
      message: HUDDLE_MEETING_NEEDS_REAUTH,
    });
    expectNothingStarted(inserts);
  });

  it("503, not 412, when Composio is unconfigured: an ops problem, not the caller's precondition", async () => {
    const { db, inserts } = makeStartDb([ACTIVE_ORG_CONNECTION]);
    const composio = gateway({ isConfigured: false });

    await expect(refusal(build(db, composio).startHuddle(CHANNEL, ME, ORG))).resolves.toEqual({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: HUDDLE_MEETING_UNCONFIGURED,
    });
    expect(composio.executeTool).not.toHaveBeenCalled();
    expectNothingStarted(inserts);
  });

  it("503 when the tool call times out or fails, which a retry genuinely can fix", async () => {
    const { db, inserts } = makeStartDb([ACTIVE_ORG_CONNECTION]);
    const composio = gateway({
      execute: jest.fn().mockRejectedValue(new Error("The operation was aborted due to timeout")),
    });

    await expect(refusal(build(db, composio).startHuddle(CHANNEL, ME, ORG))).resolves.toEqual({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: HUDDLE_MEETING_PROVIDER_FAILED,
    });
    expectNothingStarted(inserts);
  });

  it("503 when Google returns an event with no join link, rather than a huddle nobody can enter", async () => {
    const { db, inserts } = makeStartDb([ACTIVE_ORG_CONNECTION]);
    const composio = gateway({
      execute: jest.fn().mockResolvedValue({ response_data: { id: "gcal-1" } }),
    });

    await expect(refusal(build(db, composio).startHuddle(CHANNEL, ME, ORG))).resolves.toEqual({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: HUDDLE_MEETING_NO_LINK,
    });
    expectNothingStarted(inserts);
  });

  it("BITE: every refusal above is one of exactly two codes, and they are not the same code", async () => {
    const noConnection = await refusal(build(makeStartDb([]).db, gateway()).startHuddle(CHANNEL, ME, ORG));
    const unconfigured = await refusal(
      build(makeStartDb([ACTIVE_ORG_CONNECTION]).db, gateway({ isConfigured: false })).startHuddle(
        CHANNEL,
        ME,
        ORG,
      ),
    );

    expect(noConnection.status).toBe(HttpStatus.PRECONDITION_FAILED);
    expect(unconfigured.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(noConnection.status).not.toBe(unconfigured.status);
  });
});
