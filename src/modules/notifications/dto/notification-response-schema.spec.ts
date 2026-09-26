import { DB_ENUMS } from "../../../db/enums.generated";
import { notificationListResponseSchema } from "./notification-response-schema";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: "org_1",
    userId: "user_1",
    type: "INFO",
    priority: "NORMAL",
    category: "ACCOUNTING",
    sourceModule: null,
    eventKey: null,
    entityType: null,
    entityId: null,
    reason: null,
    title: "A journal was posted",
    message: "A journal was posted",
    link: null,
    isRead: false,
    pinned: false,
    channel: "IN_APP",
    metadata: null,
    archivedAt: null,
    snoozedUntil: null,
    createdAt: "2026-09-26T00:00:00.000Z",
    ticketContext: null,
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return { data: [row(overrides)], nextCursor: null, hasMore: false };
}

const notificationShape = notificationListResponseSchema.shape.data.element.shape;

function membersOf(declared: { options: readonly string[] }): string[] {
  return [...declared.options].sort();
}

describe("notificationListResponseSchema typed against the notification pgEnums rather than z.string()", () => {
  it("rejects a category the notification_category pgEnum does not declare, which z.string() accepted and hid from check:contract-parity", () => {
    expect(notificationListResponseSchema.safeParse(response({ category: "NOT_A_REAL_CATEGORY" })).success).toBe(false);
  });

  it("rejects a type the notification_type pgEnum does not declare, which z.string() accepted", () => {
    expect(notificationListResponseSchema.safeParse(response({ type: "CATASTROPHE" })).success).toBe(false);
  });

  it("rejects a priority the notification_priority pgEnum does not declare, which z.string() accepted", () => {
    expect(notificationListResponseSchema.safeParse(response({ priority: "WHENEVER" })).success).toBe(false);
  });

  it("enumerates exactly the members notification_category declares, so a frontend copy has a contract to be compared against", () => {
    expect(membersOf(notificationShape.category)).toEqual([...DB_ENUMS.notification_category].sort());
  });

  it("enumerates exactly the members notification_type declares", () => {
    expect(membersOf(notificationShape.type)).toEqual([...DB_ENUMS.notification_type].sort());
  });

  it("enumerates exactly the members notification_priority declares", () => {
    expect(membersOf(notificationShape.priority)).toEqual([...DB_ENUMS.notification_priority].sort());
  });

  it.each(DB_ENUMS.notification_category)("still parses %s, so tightening did not narrow a live category away", (category) => {
    expect(notificationListResponseSchema.safeParse(response({ category })).success).toBe(true);
  });
});
