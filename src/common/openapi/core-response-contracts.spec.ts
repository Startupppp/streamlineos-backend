import { z } from "zod";
import {
  billingEntitlementsResponseSchema,
  billingSeatsResponseSchema,
  billingSummaryResponseSchema,
} from "../../modules/billing/core/dto/billing-response-schema";
import {
  notificationCountResponseSchema,
  notificationListResponseSchema,
  notificationSuccessResponseSchema,
} from "../../modules/notifications/dto/notification-response-schema";
import {
  dashboardAnnouncementsResponseSchema,
  dashboardPersonalResponseSchema,
  dashboardStatsResponseSchema,
} from "../../modules/dashboard/dto/dashboard-response-schema";
import {
  chatOnlineResponseSchema,
  chatPresenceAckResponseSchema,
  chatUnreadResponseSchema,
  chatUsersResponseSchema,
} from "../../modules/chat/dto/chat-presence-response-schema";
import { orgModuleListResponseSchema } from "../../modules/access/dto/org-module-response-schema";
import { PLAN_FEATURE_FLAGS, PLAN_LIMITS, PLAN_LOCKED_MODULES } from "../../modules/billing/core/plan-entitlements.constants";

const at = new Date("2026-09-05T00:00:00.000Z");
const notification = {
  id: 1, orgId: "org-a", userId: "user-a", type: "INFO", priority: "NORMAL",
  category: "SYSTEM", sourceModule: null, eventKey: null, entityType: null,
  entityId: null, reason: null, title: "Reminder", message: "Message", link: null,
  isRead: false, pinned: false, channel: "IN_APP", metadata: { nested: [1, true, null] },
  archivedAt: null, snoozedUntil: null, createdAt: at, ticketContext: null,
};

describe("Core declared response contracts", () => {
  it("matches entitlement keys against the canonical plan catalog", () => {
    const limits = Object.fromEntries(Object.entries(PLAN_LIMITS)
      .map(([key, quota]) => [key, { limit: quota.FREE, used: 0 }]));
    expect(billingEntitlementsResponseSchema.safeParse({
      tier: "FREE", plan: "FREE", seatLimit: PLAN_LIMITS.members.FREE,
      lockedModules: PLAN_LOCKED_MODULES.FREE, features: PLAN_FEATURE_FLAGS.FREE, limits,
    }).success).toBe(true);
  });

  it("preserves unlimited seats and separates reserved invitations", () => {
    expect(billingSeatsResponseSchema.parse({
      total: null, used: 8, available: null, activeMembers: 5, pendingInvitations: 3,
    }).pendingInvitations).toBe(3);
    expect(billingSeatsResponseSchema.safeParse({ total: 5, used: 8 }).success).toBe(false);
  });

  it("preserves decimal money strings and an absent subscription", () => {
    const summary = {
      subscription: null,
      invoiceStats: { totalPaid: "123.45", totalOutstanding: "0", draft: 0, issued: 0, paid: 1, failed: 0, voided: 0 },
      isConfigured: false,
    };
    expect(billingSummaryResponseSchema.safeParse(summary).success).toBe(true);
    expect(billingSummaryResponseSchema.safeParse({
      ...summary, invoiceStats: { ...summary.invoiceStats, totalPaid: 123.45 },
    }).success).toBe(false);
  });

  it.each([at, at.toISOString()])("accepts notification timestamps before and after cache serialization (%s)", (createdAt) => {
    expect(notificationListResponseSchema.safeParse({
      data: [{ ...notification, createdAt }], hasMore: true, nextCursor: 1,
    }).success).toBe(true);
  });

  it("requires explicit notification continuation and rejects an overlong page", () => {
    expect(notificationListResponseSchema.safeParse({ data: [], hasMore: false }).success).toBe(false);
    expect(notificationListResponseSchema.safeParse({
      data: Array.from({ length: 101 }, () => notification), hasMore: true, nextCursor: 1,
    }).success).toBe(false);
  });

  it("rejects missing or incorrectly typed count and action responses", () => {
    expect(notificationCountResponseSchema.safeParse({ count: "0" }).success).toBe(false);
    expect(notificationCountResponseSchema.safeParse({ count: -1 }).success).toBe(false);
    expect(notificationSuccessResponseSchema.safeParse({ success: false }).success).toBe(false);
    expect(chatPresenceAckResponseSchema.safeParse({ ok: true }).success).toBe(true);
    expect(chatUnreadResponseSchema.safeParse({ total: 100 }).success).toBe(true);
    expect(chatUnreadResponseSchema.safeParse({ total: 101 }).success).toBe(false);
  });

  it("accepts denied/degraded Home sections without pretending they are counts", () => {
    expect(dashboardStatsResponseSchema.safeParse({
      orgName: "Organization", orgSlug: "org", totalEmployees: null, activeProjects: null, presentToday: null,
    }).success).toBe(true);
    expect(dashboardPersonalResponseSchema.safeParse({
      myTasks: [], timesheetStatus: { submitted: false, weekLabel: "Sep 1–7", hoursLogged: 0 },
      upcomingEvents: [{ id: 1, title: "Meeting", startTime: at, endTime: at, type: "meeting" }],
      degraded: ["myTasks"],
    }).success).toBe(true);
  });

  it("preserves nullable announcement author names and expiry", () => {
    expect(dashboardAnnouncementsResponseSchema.safeParse([{
      id: 1, content: "Announcement", isPinned: false, expiresAt: null, createdAt: at,
      authorId: "user-a", authorName: null, authorFirstName: null, authorLastName: null,
    }]).success).toBe(true);
  });

  it("describes core module standing and presence user projections", () => {
    expect(orgModuleListResponseSchema.safeParse([{ moduleKey: "home", enabled: true, core: true }]).success).toBe(true);
    expect(chatOnlineResponseSchema.safeParse([{
      userId: "user-a", status: "ONLINE", lastSeenAt: at, userName: null, userImage: null,
    }]).success).toBe(true);
    expect(chatUsersResponseSchema.safeParse([{
      id: "user-a", name: null, email: "a@example.com", image: null, role: "MEMBER",
    }]).success).toBe(true);
  });

  it.each([
    billingEntitlementsResponseSchema, billingSeatsResponseSchema, billingSummaryResponseSchema,
    notificationCountResponseSchema, notificationListResponseSchema, notificationSuccessResponseSchema,
    dashboardAnnouncementsResponseSchema, dashboardPersonalResponseSchema, dashboardStatsResponseSchema,
    chatOnlineResponseSchema, chatPresenceAckResponseSchema, chatUnreadResponseSchema,
    chatUsersResponseSchema, orgModuleListResponseSchema,
  ])("produces a concrete JSON schema rather than an empty coverage placeholder", (schema) => {
    const json = z.toJSONSchema(schema, { unrepresentable: "any", target: "draft-7" });
    expect(["object", "array"]).toContain(json.type);
    if (json.type === "object") expect(Object.keys(json.properties ?? {}).length).toBeGreaterThan(0);
  });
});
