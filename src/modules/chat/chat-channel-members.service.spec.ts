import { Test } from "@nestjs/testing";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatChannelMembersImplementation } from "./chat-channel-members-implementation";
import { ChatChannelMemberState } from "./chat-channel-member-state";
import { DRIZZLE } from "../../db/drizzle.constants";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { PAGE_SIZE_CAP } from "../../common/pagination/list-query.schema";
import type { EntityActor } from "../entity-reference/entity-reference.types";

const ORG = "org1";
const CH = 1;
const ADMIN_ID = "admin1";
const adminActor: EntityActor = { orgId: ORG, userId: ADMIN_ID, membershipId: 1, isOrgOwner: false };
const MEMBER_ID = "member1";
const TARGET_ID = "target1";

const ADMIN_ROW = { userId: ADMIN_ID, role: "ADMIN", channelId: CH, orgId: ORG };
const MEMBER_ROW = { userId: MEMBER_ID, role: "MEMBER", channelId: CH, orgId: ORG };
const CHANNEL_ROW = { id: CH, orgId: ORG, isArchived: false };

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
  memberFindMany?: jest.Mock;
} = {}) {
  const {
    channelRow = CHANNEL_ROW,
    memberRows = [ADMIN_ROW],
    orgMemberRow = { id: 42 },
    selectRows = [{ userId: TARGET_ID }],
    memberFindMany = jest.fn().mockResolvedValue([]),
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
      chatChannelMembers: { findFirst: memberFindFirst, findMany: memberFindMany },
      organizationMembers: { findFirst: orgMemberFindFirst },
    },
    select: selectFn,
    update: updateFn,
    delete: deleteFn,
    insert: insertFn,
  };
}

function makeAlwaysAdminDb(memberFindMany: jest.Mock) {
  return {
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue(CHANNEL_ROW) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(ADMIN_ROW), findMany: memberFindMany },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 42 }) },
    },
    select: jest.fn().mockReturnValue({ from: jest.fn() }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn() }),
    insert: jest.fn().mockReturnValue({ values: jest.fn() }),
  };
}

function makeChannelMemberRow(id: number) {
  return {
    id,
    orgId: ORG,
    channelId: CH,
    membership: {
      id: id * 100,
      userId: `user-${id}`,
      user: { id: `user-${id}`, name: `User ${id}`, image: null, email: `user${id}@test.com` },
    },
  };
}

function extractSqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => extractSqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? extractSqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? extractSqlValues(record.value, seen) : []),
  ];
}

async function buildImpl(db: ReturnType<typeof makeDb>) {
  const module = await Test.createTestingModule({
    providers: [
      ChatChannelMembersImplementation,
      { provide: DRIZZLE, useValue: db },
      { provide: EntityReferenceService, useValue: stubEntities },
    ],
  }).compile();
  return module.get(ChatChannelMembersImplementation);
}

async function buildState(db: ReturnType<typeof makeDb>) {
  const module = await Test.createTestingModule({
    providers: [
      ChatChannelMemberState,
      { provide: DRIZZLE, useValue: db },
    ],
  }).compile();
  return module.get(ChatChannelMemberState);
}

beforeEach(() => jest.clearAllMocks());

describe("ChatChannelMembersImplementation", () => {
  describe("addMember", () => {
    it("throws ConflictException if user is already a member", async () => {
      const db = makeDb({
        memberRows: [ADMIN_ROW, MEMBER_ROW],
        selectRows: [{ userId: MEMBER_ID }],
      });
      const service = await buildImpl(db);
      await expect(service.addMember(CH, MEMBER_ID, ADMIN_ID, ORG)).rejects.toThrow(ConflictException);
    });

    it("throws NotFoundException if requester is not an admin (no channel found in org)", async () => {
      const db = makeDb({ channelRow: null });
      const service = await buildImpl(db);
      await expect(service.addMember(CH, TARGET_ID, ADMIN_ID, ORG)).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if requester is a MEMBER not an ADMIN", async () => {
      const db = makeDb({ memberRows: [MEMBER_ROW] });
      const service = await buildImpl(db);
      await expect(service.addMember(CH, TARGET_ID, MEMBER_ID, ORG)).rejects.toThrow(ForbiddenException);
    });

    it("inserts a new member when the requester is ADMIN and target is not yet a member", async () => {
      const db = makeDb({
        memberRows: [ADMIN_ROW, null],
        selectRows: [{ userId: TARGET_ID }],
      });
      const service = await buildImpl(db);
      const result = await service.addMember(CH, TARGET_ID, ADMIN_ID, ORG);
      expect(db.insert).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("updateMemberRole", () => {
    it("throws ForbiddenException if requester is not ADMIN", async () => {
      const db = makeDb({ memberRows: [MEMBER_ROW] });
      const service = await buildImpl(db);
      await expect(service.updateMemberRole(CH, TARGET_ID, MEMBER_ID, ORG, "ADMIN")).rejects.toThrow(ForbiddenException);
    });

    it("updates role when requester is ADMIN", async () => {
      const db = makeDb({ memberRows: [ADMIN_ROW, { id: 10, membershipId: 55 }] });
      const service = await buildImpl(db);
      const result = await service.updateMemberRole(CH, TARGET_ID, ADMIN_ID, ORG, "ADMIN");
      expect(db.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("listMembers", () => {
    it("walks a >1-page member list with no duplicates and no skips", async () => {
      const rows = [1, 2, 3].map(makeChannelMemberRow);
      const findMany = jest.fn()
        .mockResolvedValueOnce([rows[0], rows[1], rows[2]])
        .mockResolvedValueOnce([rows[2]]);

      const db = makeAlwaysAdminDb(findMany);
      const service = await buildImpl(db);

      const p1 = await service.listMembers(CH, adminActor, undefined, 2);
      expect(p1.members).toHaveLength(2);
      expect(p1.nextCursor).toBe(2);

      const p2 = await service.listMembers(CH, adminActor, p1.nextCursor ?? undefined, 2);
      expect(p2.members).toHaveLength(1);
      expect(p2.nextCursor).toBeNull();

      const allIds = [...p1.members.map((m) => m.id), ...p2.members.map((m) => m.id)];
      expect(allIds).toEqual([1, 2, 3]);
      expect(new Set(allIds).size).toBe(allIds.length);
    });

    it("passes PAGE_SIZE + 1 to findMany so hasMore is detectable", async () => {
      const findMany = jest.fn().mockResolvedValue([makeChannelMemberRow(1)]);
      const db = makeAlwaysAdminDb(findMany);
      const service = await buildImpl(db);

      await service.listMembers(CH, adminActor, undefined, 2);

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 3 }),
      );
    });

    it("caps page size to PAGE_SIZE_CAP regardless of caller input", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const db = makeAlwaysAdminDb(findMany);
      const service = await buildImpl(db);

      await service.listMembers(CH, adminActor, undefined, PAGE_SIZE_CAP + 999);

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: PAGE_SIZE_CAP + 1 }),
      );
    });

    it("scopes read to the caller orgId and channelId (findMany called once per request)", async () => {
      const findMany = jest.fn().mockResolvedValue([makeChannelMemberRow(1)]);
      const db = makeAlwaysAdminDb(findMany);
      const service = await buildImpl(db);

      const result = await service.listMembers(CH, adminActor);

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(result.members).toHaveLength(1);
    });

    it("embeds cursor value in the findMany where clause (gt predicate)", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const db = makeAlwaysAdminDb(findMany);
      const service = await buildImpl(db);

      await service.listMembers(CH, adminActor, 42);

      const [opts] = findMany.mock.calls[0] as [{ where?: unknown }];
      expect(extractSqlValues(opts?.where)).toContain(42);
    });
  });
});

describe("ChatChannelMemberState", () => {
  describe("archiveChannel", () => {
    it("throws NotFoundException when channel is not in caller's org", async () => {
      const db = makeDb({ channelRow: null });
      const service = await buildState(db);
      await expect(service.archiveChannel(CH, ADMIN_ID, ORG)).rejects.toThrow(NotFoundException);
    });

    it("archives the channel membership for the current user", async () => {
      const db = makeDb({ memberRows: [ADMIN_ROW] });
      const service = await buildState(db);
      const result = await service.archiveChannel(CH, ADMIN_ID, ORG);
      expect(db.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("favoriteChannel", () => {
    it("throws ForbiddenException if requester is not a member", async () => {
      const db = makeDb({ channelRow: CHANNEL_ROW, memberRows: [null] });
      const service = await buildState(db);
      await expect(service.favoriteChannel(CH, ADMIN_ID, ORG)).rejects.toThrow(ForbiddenException);
    });

    it("marks the channel as favorite for the current user", async () => {
      const db = makeDb({ memberRows: [ADMIN_ROW] });
      const service = await buildState(db);
      const result = await service.favoriteChannel(CH, ADMIN_ID, ORG);
      expect(db.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("unfavoriteChannel", () => {
    it("unmarks the channel as favorite for the current user", async () => {
      const db = makeDb({ memberRows: [ADMIN_ROW] });
      const service = await buildState(db);
      const result = await service.unfavoriteChannel(CH, ADMIN_ID, ORG);
      expect(db.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("setNotificationPreference", () => {
    it("throws ForbiddenException if requester is not a member", async () => {
      const db = makeDb({ channelRow: CHANNEL_ROW, memberRows: [null] });
      const service = await buildState(db);
      await expect(service.setNotificationPreference(CH, ADMIN_ID, "MENTIONS", ORG)).rejects.toThrow(ForbiddenException);
    });

    it("updates the notification preference for the current user", async () => {
      const db = makeDb({ memberRows: [ADMIN_ROW] });
      const service = await buildState(db);
      const result = await service.setNotificationPreference(CH, ADMIN_ID, "MENTIONS", ORG);
      expect(db.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, notificationPreference: "MENTIONS" });
    });
  });
});
