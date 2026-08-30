import { Test } from "@nestjs/testing";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatChannelMembersService } from "./chat-channel-members.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";

const ORG = "org1";
const CH = 1;
const ADMIN_ID = "admin1";
const MEMBER_ID = "member1";
const TARGET_ID = "target1";

const ADMIN_ROW = { userId: ADMIN_ID, role: "ADMIN", channelId: CH, orgId: ORG };
const MEMBER_ROW = { userId: MEMBER_ID, role: "MEMBER", channelId: CH, orgId: ORG };
const CHANNEL_ROW = { id: CH, orgId: ORG, isArchived: false };

const stubCache = {
  cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
  invalidate: jest.fn().mockResolvedValue(undefined),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  invalidatePattern: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
};

const stubEntities = {
  resolve: jest.fn().mockResolvedValue([{ status: "resolved" }]),
  actionsFor: jest.fn().mockResolvedValue([[]]),
  submitAction: jest.fn(),
  isKnownType: jest.fn().mockReturnValue(true),
} as unknown as EntityReferenceService;

function makeDb(opts: {
  channelRow?: object | null;
  memberRows?: (object | null)[];
  orgMemberRow?: object | null;
  selectRows?: object[];
} = {}) {
  const {
    channelRow = CHANNEL_ROW,
    memberRows = [ADMIN_ROW],
    orgMemberRow = { id: 42 },
    selectRows = [{ userId: TARGET_ID }],
  } = opts;

  const memberFindFirst = jest.fn();
  for (const row of memberRows) memberFindFirst.mockResolvedValueOnce(row);
  memberFindFirst.mockResolvedValue(null);

  const channelFindFirst = jest.fn().mockResolvedValue(channelRow);
  const orgMemberFindFirst = jest.fn().mockResolvedValue(orgMemberRow);

  const whereSelect = jest.fn().mockResolvedValue(selectRows);
  const fromSelect = jest.fn().mockReturnValue({ where: whereSelect });
  const selectFn = jest.fn().mockReturnValue({ from: fromSelect });

  const whereUpdate = jest.fn().mockResolvedValue({ rowCount: 1 });
  const setFn = jest.fn().mockReturnValue({ where: whereUpdate });
  const updateFn = jest.fn().mockReturnValue({ set: setFn });

  const whereDelete = jest.fn().mockResolvedValue({ rowCount: 1 });
  const deleteFn = jest.fn().mockReturnValue({ where: whereDelete });

  const valuesFn = jest.fn().mockResolvedValue(undefined);
  const insertFn = jest.fn().mockReturnValue({ values: valuesFn });

  return {
    query: {
      chatChannels: { findFirst: channelFindFirst },
      chatChannelMembers: { findFirst: memberFindFirst, findMany: jest.fn().mockResolvedValue([]) },
      organizationMembers: { findFirst: orgMemberFindFirst },
    },
    select: selectFn,
    update: updateFn,
    delete: deleteFn,
    insert: insertFn,
  };
}

async function build(db: ReturnType<typeof makeDb>) {
  const module = await Test.createTestingModule({
    providers: [
      ChatChannelMembersService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: stubCache },
      { provide: EntityReferenceService, useValue: stubEntities },
    ],
  }).compile();
  return module.get(ChatChannelMembersService);
}

beforeEach(() => jest.clearAllMocks());

describe("ChatChannelMembersService", () => {
  describe("addMember", () => {
    it("throws ConflictException if user is already a member", async () => {
      const db = makeDb({
        memberRows: [ADMIN_ROW, MEMBER_ROW],
        selectRows: [{ userId: MEMBER_ID }],
      });
      const service = await build(db);
      await expect(service.addMember(CH, MEMBER_ID, ADMIN_ID, ORG)).rejects.toThrow(ConflictException);
    });

    it("throws NotFoundException if requester is not an admin (no channel found in org)", async () => {
      const db = makeDb({ channelRow: null });
      const service = await build(db);
      await expect(service.addMember(CH, TARGET_ID, ADMIN_ID, ORG)).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if requester is a MEMBER not an ADMIN", async () => {
      const db = makeDb({ memberRows: [MEMBER_ROW] });
      const service = await build(db);
      await expect(service.addMember(CH, TARGET_ID, MEMBER_ID, ORG)).rejects.toThrow(ForbiddenException);
    });

    it("inserts a new member when the requester is ADMIN and target is not yet a member", async () => {
      const db = makeDb({
        memberRows: [ADMIN_ROW, null],
        selectRows: [{ userId: TARGET_ID }],
      });
      const service = await build(db);
      const result = await service.addMember(CH, TARGET_ID, ADMIN_ID, ORG);
      expect(db.insert).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("updateMemberRole", () => {
    it("throws ForbiddenException if requester is not ADMIN", async () => {
      const db = makeDb({ memberRows: [MEMBER_ROW] });
      const service = await build(db);
      await expect(service.updateMemberRole(CH, TARGET_ID, MEMBER_ID, ORG, "ADMIN")).rejects.toThrow(ForbiddenException);
    });

    it("updates role when requester is ADMIN", async () => {
      const db = makeDb({ memberRows: [ADMIN_ROW] });
      const service = await build(db);
      const result = await service.updateMemberRole(CH, TARGET_ID, ADMIN_ID, ORG, "ADMIN");
      expect(db.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("archiveChannel", () => {
    it("throws NotFoundException when channel is not in caller's org", async () => {
      const db = makeDb({ channelRow: null });
      const service = await build(db);
      await expect(service.archiveChannel(CH, ADMIN_ID, ORG)).rejects.toThrow(NotFoundException);
    });

    it("archives the channel membership for the current user", async () => {
      const db = makeDb({ memberRows: [ADMIN_ROW] });
      const service = await build(db);
      const result = await service.archiveChannel(CH, ADMIN_ID, ORG);
      expect(db.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("favoriteChannel", () => {
    it("throws ForbiddenException if requester is not a member", async () => {
      const db = makeDb({ channelRow: CHANNEL_ROW, memberRows: [null] });
      const service = await build(db);
      await expect(service.favoriteChannel(CH, ADMIN_ID, ORG)).rejects.toThrow(ForbiddenException);
    });

    it("marks the channel as favorite for the current user", async () => {
      const db = makeDb({ memberRows: [ADMIN_ROW] });
      const service = await build(db);
      const result = await service.favoriteChannel(CH, ADMIN_ID, ORG);
      expect(db.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("unfavoriteChannel", () => {
    it("unmarks the channel as favorite for the current user", async () => {
      const db = makeDb({ memberRows: [ADMIN_ROW] });
      const service = await build(db);
      const result = await service.unfavoriteChannel(CH, ADMIN_ID, ORG);
      expect(db.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("setNotificationPreference", () => {
    it("throws ForbiddenException if requester is not a member", async () => {
      const db = makeDb({ channelRow: CHANNEL_ROW, memberRows: [null] });
      const service = await build(db);
      await expect(service.setNotificationPreference(CH, ADMIN_ID, "MENTIONS", ORG)).rejects.toThrow(ForbiddenException);
    });

    it("updates the notification preference for the current user", async () => {
      const db = makeDb({ memberRows: [ADMIN_ROW] });
      const service = await build(db);
      const result = await service.setNotificationPreference(CH, ADMIN_ID, "MENTIONS", ORG);
      expect(db.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, notificationPreference: "MENTIONS" });
    });
  });
});
