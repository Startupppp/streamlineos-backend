import {
  EMPLOYMENT_FIELDS_DROPPED_IN_V2,
  toUserIdentity,
  toUserIdentityPage,
} from "./user-identity.view";

const userV1 = {
  id: "user-1",
  email: "asha@example.com",
  firstName: "Asha",
  lastName: "Rao",
  isActive: true,
  joinedAt: "2026-01-01",
  designation: "Staff Engineer",
  departmentId: "dept-1",
  branchId: "branch-1",
  reportingTo: "user-2",
};

describe("v2 user identity view", () => {
  it("drops every employment field the version declares", () => {
    const identity = toUserIdentity(userV1);
    for (const field of EMPLOYMENT_FIELDS_DROPPED_IN_V2)
      expect(identity).not.toHaveProperty(field);
  });

  it("keeps identity and membership fields untouched", () => {
    expect(toUserIdentity(userV1)).toEqual({
      id: "user-1",
      email: "asha@example.com",
      firstName: "Asha",
      lastName: "Rao",
      isActive: true,
      joinedAt: "2026-01-01",
    });
  });

  it("does not mutate the v1 payload the compatibility route still serves", () => {
    toUserIdentity(userV1);
    expect(userV1.designation).toBe("Staff Engineer");
    expect(userV1.reportingTo).toBe("user-2");
  });

  it("maps a page without disturbing its pagination envelope", () => {
    const page = {
      data: [userV1],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
    };
    const mapped = toUserIdentityPage(page);

    expect(mapped.pagination).toEqual(page.pagination);
    expect(mapped.data[0]).not.toHaveProperty("designation");
    expect(mapped.data[0]).toHaveProperty("id", "user-1");
  });

  it("tolerates a payload that never carried the employment fields", () => {
    expect(toUserIdentity({ id: "user-9" })).toEqual({ id: "user-9" });
  });
});
