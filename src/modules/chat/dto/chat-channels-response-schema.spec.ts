import {
  channelMemberPreviewSchema,
  channelDetailMemberSchema,
  channelListItemSchema,
  channelPublicListItemSchema,
  channelDetailSchema,
  channelNotifPrefResponseSchema,
} from "./chat-channels-response.schemas";

const BASE_PREVIEW_MEMBER = {
  id: 1,
  channelId: 2,
  userId: "u1",
  role: "MEMBER",
  mutedUntil: null,
  isFavorite: false,
  notificationPreference: "DEFAULT",
  user: null,
};

const BASE_DETAIL_MEMBER = {
  id: 1,
  channelId: 1,
  userId: "u1",
  role: "MEMBER",
  lastReadAt: null,
  joinedAt: new Date(),
  mutedUntil: null,
  archivedAt: null,
  isFavorite: false,
  notificationPreference: "DEFAULT",
  user: null,
};

const BASE_CHANNEL_LIST_ITEM = {
  id: 1,
  name: "General",
  type: "GROUP",
  avatarUrl: null,
  isArchived: false,
  entityType: null,
  entityId: null,
  members: [],
  memberCount: 0,
  membersTruncated: false,
  unreadCount: 0,
  lastMessage: null,
};

const BASE_PUBLIC_CHANNEL = {
  id: 1,
  name: "Public",
  type: "PUBLIC",
  description: null,
  avatarUrl: null,
  createdAt: new Date(),
  lastMessageAt: new Date(),
  memberCount: 5,
  isMember: false,
};

const BASE_CHANNEL_DETAIL = {
  id: 1,
  orgId: "org-1",
  name: "General",
  type: "GROUP",
  description: null,
  avatarUrl: null,
  isArchived: false,
  entityType: null,
  entityId: null,
  isPinned: false,
  isPrivate: false,
  messageCount: 0,
  lastMessageAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  members: [],
};

describe("chat-channels-response schemas — enum field narrowing", () => {
  describe("channelMemberPreviewSchema.role", () => {
    it("accepts ADMIN and MEMBER", () => {
      expect(() =>
        channelMemberPreviewSchema.parse({ ...BASE_PREVIEW_MEMBER, role: "ADMIN" }),
      ).not.toThrow();
      expect(() =>
        channelMemberPreviewSchema.parse({ ...BASE_PREVIEW_MEMBER, role: "MEMBER" }),
      ).not.toThrow();
    });

    it("rejects a role outside the allowed set", () => {
      expect(() =>
        channelMemberPreviewSchema.parse({ ...BASE_PREVIEW_MEMBER, role: "SUPERADMIN" }),
      ).toThrow();
    });
  });

  describe("channelMemberPreviewSchema.notificationPreference", () => {
    it("accepts all four notification preferences", () => {
      for (const pref of ["DEFAULT", "ALL", "MENTIONS", "NOTHING"]) {
        expect(() =>
          channelMemberPreviewSchema.parse({ ...BASE_PREVIEW_MEMBER, notificationPreference: pref }),
        ).not.toThrow();
      }
    });

    it("rejects an unrecognised notification preference", () => {
      expect(() =>
        channelMemberPreviewSchema.parse({ ...BASE_PREVIEW_MEMBER, notificationPreference: "EVERYTHING" }),
      ).toThrow();
    });
  });

  describe("channelDetailMemberSchema.role", () => {
    it("accepts a valid role", () => {
      expect(() => channelDetailMemberSchema.parse(BASE_DETAIL_MEMBER)).not.toThrow();
    });

    it("rejects a role outside the allowed set", () => {
      expect(() =>
        channelDetailMemberSchema.parse({ ...BASE_DETAIL_MEMBER, role: "OWNER" }),
      ).toThrow();
    });
  });

  describe("channelDetailMemberSchema.notificationPreference", () => {
    it("rejects an unrecognised notification preference", () => {
      expect(() =>
        channelDetailMemberSchema.parse({ ...BASE_DETAIL_MEMBER, notificationPreference: "SILENT" }),
      ).toThrow();
    });

    it("accepts a valid notification preference", () => {
      expect(() =>
        channelDetailMemberSchema.parse({ ...BASE_DETAIL_MEMBER, notificationPreference: "ALL" }),
      ).not.toThrow();
    });
  });

  describe("channelListItemSchema.type", () => {
    it("accepts all four channel types", () => {
      for (const type of ["DIRECT", "GROUP", "PUBLIC", "PRIVATE"]) {
        expect(() =>
          channelListItemSchema.parse({ ...BASE_CHANNEL_LIST_ITEM, type }),
        ).not.toThrow();
      }
    });

    it("rejects an unrecognised channel type", () => {
      expect(() =>
        channelListItemSchema.parse({ ...BASE_CHANNEL_LIST_ITEM, type: "BROADCAST" }),
      ).toThrow();
    });
  });

  describe("channelPublicListItemSchema.type", () => {
    it("accepts a valid channel type", () => {
      expect(() => channelPublicListItemSchema.parse(BASE_PUBLIC_CHANNEL)).not.toThrow();
    });

    it("rejects an unrecognised channel type", () => {
      expect(() =>
        channelPublicListItemSchema.parse({ ...BASE_PUBLIC_CHANNEL, type: "ANNOUNCEMENT" }),
      ).toThrow();
    });
  });

  describe("channelDetailSchema.type", () => {
    it("accepts a valid channel type", () => {
      expect(() => channelDetailSchema.parse(BASE_CHANNEL_DETAIL)).not.toThrow();
    });

    it("rejects an unrecognised channel type", () => {
      expect(() =>
        channelDetailSchema.parse({ ...BASE_CHANNEL_DETAIL, type: "ANNOUNCEMENT" }),
      ).toThrow();
    });
  });

  describe("channelNotifPrefResponseSchema.notificationPreference", () => {
    it("accepts a valid preference", () => {
      expect(() =>
        channelNotifPrefResponseSchema.parse({ ok: true, notificationPreference: "ALL" }),
      ).not.toThrow();
    });

    it("rejects an unrecognised preference", () => {
      expect(() =>
        channelNotifPrefResponseSchema.parse({ ok: true, notificationPreference: "UNKNOWN" }),
      ).toThrow();
    });
  });
});
