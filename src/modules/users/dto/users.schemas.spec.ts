import { bulkInviteSchema, bulkUpdateUsersSchema } from "./users.schemas";
import { userIdentityListResponseSchema } from "./users-response.schemas";

const now = new Date("2026-09-14T10:00:00.000Z");

const baseUserListItem = {
  membershipId: 1,
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  firstName: "Test",
  lastName: "User",
  image: null,
  role: "MEMBER",
  isOwner: false,
  phone: null,
  createdAt: now,
  joinedAt: now,
  lastSeenAt: null,
  teams: [],
  isActive: true,
  userStatus: "active",
  archivedAt: null,
};

const page = (item: object) => ({
  data: [item],
  pagination: { limit: 25, hasMore: false, nextCursor: null },
});

describe("userIdentityListResponseSchema — emailVerified projection", () => {
  it("accepts emailVerified: false — the projection of a null timestamp", () => {
    expect(
      userIdentityListResponseSchema.safeParse(page({ ...baseUserListItem, emailVerified: false })).success,
    ).toBe(true);
  });

  it("accepts emailVerified: true — the projection of a non-null timestamp", () => {
    expect(
      userIdentityListResponseSchema.safeParse(page({ ...baseUserListItem, emailVerified: true })).success,
    ).toBe(true);
  });

  it("rejects emailVerified as an ISO string — the old unguarded raw-column shape", () => {
    const result = userIdentityListResponseSchema.safeParse(
      page({ ...baseUserListItem, emailVerified: "2026-09-14T10:00:00.000Z" }),
    );
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((i) => i.path.join(".")) ?? [];
    expect(paths.some((p) => p.includes("emailVerified"))).toBe(true);
  });

  it("rejects emailVerified as a Date object — the other raw-column shape", () => {
    const result = userIdentityListResponseSchema.safeParse(
      page({ ...baseUserListItem, emailVerified: now }),
    );
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((i) => i.path.join(".")) ?? [];
    expect(paths.some((p) => p.includes("emailVerified"))).toBe(true);
  });
});

describe("bulkInviteSchema", () => {
  const emails = (count: number) =>
    Array.from({ length: count }, (_, index) => `person-${index}@example.com`);

  it("accepts more than 100 invitations in one setup request", () => {
    expect(
      bulkInviteSchema.safeParse({ emails: emails(125), role: "MEMBER" }).success,
    ).toBe(true);
  });

  it("accepts 500 invitations and rejects oversized requests", () => {
    expect(bulkInviteSchema.safeParse({ emails: emails(500) }).success).toBe(true);
    expect(bulkInviteSchema.safeParse({ emails: emails(501) }).success).toBe(false);
  });
});

describe("bulkUpdateUsersSchema", () => {
  it("rejects managerUserId as an unknown key: manager changes go through the bulk reporting change", () => {
    expect(bulkUpdateUsersSchema.safeParse({ userIds: ["u-1"], managerUserId: "m-1" }).success).toBe(false);
    expect(bulkUpdateUsersSchema.safeParse({ userIds: ["u-1"], managerUserId: null }).success).toBe(false);
  });

  it("still accepts the organisational fields", () => {
    expect(bulkUpdateUsersSchema.safeParse({ userIds: ["u-1"], departmentId: "d-1", branchId: null, teamId: "t-1" }).success).toBe(true);
  });
});
