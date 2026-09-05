import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { notifications } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * List-contract properties that the existing recipient-isolation spec does not cover.
 *
 * The existing spec proves that 404 (not 403) is returned on markRead for a
 * cross-tenant or wrong-user notification id. This file asks four complementary
 * questions about the list and count surfaces:
 *
 *   count-list coherence  the unreadCount value equals the length of the UNREAD
 *                         list under the same filter; both query the same scope and
 *                         the same retention window, so the two numbers must agree
 *                         for a freshly-inserted, unread, non-deleted set
 *
 *   page cap              requesting limit=100 on a membership with 105 unread
 *                         notifications returns data.length=100 and hasMore=true;
 *                         the platform ceiling is PAGE_SIZE_CAP=100 and the read
 *                         service enforces Math.min(limit, 100) before querying
 *
 *   deleted not surfaced  a notification soft-deleted via DELETE /notifications/:id
 *                         does not appear in a subsequent GET /notifications list;
 *                         the read service predicate isNull(deletedAt) must be live,
 *                         not a convention, and the cache is invalidated on delete
 *
 *   cross-tenant 404      a member of org B using org A's notification id on
 *                         PATCH /notifications/:id/archive receives 404, not 403;
 *                         a 403 would confirm the record exists (existence oracle)
 *
 * DOES NOT PROVE: that the markRead isolation is attributable to the service
 * predicate vs RLS — see notification-recipient-isolation.seeded-e2e-spec.ts.
 */
describe("[seeded-e2e] Notifications — list contract", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let countToken = "";
  let bulkToken = "";
  let neighbourToken = "";
  let server: unknown;

  const countIds: number[] = [];
  let softDeleteId = 0;
  const bulkIds: number[] = [];
  let neighbourNotifId = 0;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("countUser")
      .addMember("bulkUser")
      .build();

    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("member")
      .build();

    countToken = await signSeededToken(seeded, home.members.countUser.userId, home.orgId);
    bulkToken = await signSeededToken(seeded, home.members.bulkUser.userId, home.orgId);
    neighbourToken = await signSeededToken(
      seeded,
      neighbour.members.member.userId,
      neighbour.orgId,
    );

    const countRows = await seeded.seedDb
      .insert(notifications)
      .values([
        { orgId: home.orgId, membershipId: home.members.countUser.membershipId, title: "C1", message: "m1" },
        { orgId: home.orgId, membershipId: home.members.countUser.membershipId, title: "C2", message: "m2" },
        { orgId: home.orgId, membershipId: home.members.countUser.membershipId, title: "C3", message: "m3" },
      ])
      .returning({ id: notifications.id });
    for (const row of countRows) countIds.push(row.id);

    const [softRow] = await seeded.seedDb
      .insert(notifications)
      .values({
        orgId: home.orgId,
        membershipId: home.members.countUser.membershipId,
        title: "SD",
        message: "soft-delete me",
      })
      .returning({ id: notifications.id });
    softDeleteId = softRow?.id ?? 0;

    const bulkValues = Array.from({ length: 105 }, (_, i) => ({
      orgId: home.orgId,
      membershipId: home.members.bulkUser.membershipId,
      title: `B${String(i + 1)}`,
      message: `bulk ${String(i + 1)}`,
    }));
    const bulkRows = await seeded.seedDb
      .insert(notifications)
      .values(bulkValues)
      .returning({ id: notifications.id });
    for (const row of bulkRows) bulkIds.push(row.id);

    const [nRow] = await seeded.seedDb
      .insert(notifications)
      .values({
        orgId: neighbour.orgId,
        membershipId: neighbour.members.member.membershipId,
        title: "N1",
        message: "n1",
      })
      .returning({ id: notifications.id });
    neighbourNotifId = nRow?.id ?? 0;
  }, 180_000);

  afterAll(async () => {
    if (neighbourNotifId > 0)
      await seeded.seedDb.delete(notifications).where(eq(notifications.id, neighbourNotifId));
    if (bulkIds.length > 0)
      await seeded.seedDb.delete(notifications).where(inArray(notifications.id, bulkIds));
    if (softDeleteId > 0)
      await seeded.seedDb.delete(notifications).where(eq(notifications.id, softDeleteId));
    if (countIds.length > 0)
      await seeded.seedDb.delete(notifications).where(inArray(notifications.id, countIds));
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("fixture check — orgs are distinct, notification ids are positive, and bulk count matches", () => {
    expect(home.orgId).not.toBe(neighbour.orgId);
    expect(countIds.length).toBe(3);
    expect(softDeleteId).toBeGreaterThan(0);
    expect(bulkIds.length).toBe(105);
    expect(neighbourNotifId).toBeGreaterThan(0);
  });

  it("COUNT-LIST COHERENCE — unread-count matches the length of the UNREAD list for a fresh set of 3 notifications", async () => {
    const countRes = await request(server as never)
      .get("/notifications/unread-count")
      .set("Authorization", `Bearer ${countToken}`);
    expect(countRes.status).toBe(200);

    const listRes = await request(server as never)
      .get("/notifications?section=UNREAD&limit=100")
      .set("Authorization", `Bearer ${countToken}`);
    expect(listRes.status).toBe(200);

    const countValue = Number(countRes.body.count);
    const listData: unknown[] = Array.isArray(listRes.body.data) ? listRes.body.data : [];

    expect(countValue).toBeGreaterThanOrEqual(3);
    expect(listData.length).toBeGreaterThanOrEqual(3);
    expect(countValue).toBe(listData.length);
  });

  it("PAGE CAP — 105 notifications for bulkUser; limit=100 returns data.length=100 and hasMore=true", async () => {
    const res = await request(server as never)
      .get("/notifications?limit=100")
      .set("Authorization", `Bearer ${bulkToken}`);
    expect(res.status).toBe(200);

    const data: unknown[] = Array.isArray(res.body.data) ? res.body.data : [];
    expect(data.length).toBe(100);
    expect(res.body.hasMore).toBe(true);
  });

  it("SOFT-DELETE — a deleted notification does not appear in subsequent GET /notifications", async () => {
    expect(softDeleteId).toBeGreaterThan(0);

    const del = await request(server as never)
      .delete(`/notifications/${String(softDeleteId)}`)
      .set("Authorization", `Bearer ${countToken}`);
    expect(del.status).toBe(200);

    const list = await request(server as never)
      .get("/notifications?limit=100")
      .set("Authorization", `Bearer ${countToken}`);
    expect(list.status).toBe(200);

    const returnedIds: number[] = [];
    if (Array.isArray(list.body.data)) {
      for (const item of list.body.data) {
        if (item !== null && typeof item === "object" && "id" in item && typeof item.id === "number")
          returnedIds.push(item.id);
      }
    }
    expect(returnedIds).not.toContain(softDeleteId);
  });

  it("CROSS-TENANT 404 — a neighbour-org member archiving org A's notification receives 404, not 403", async () => {
    const targetId = countIds[0];
    expect(targetId).toBeDefined();
    expect(targetId).toBeGreaterThan(0);

    const res = await request(server as never)
      .patch(`/notifications/${String(targetId)}/archive`)
      .set("Authorization", `Bearer ${neighbourToken}`);

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("continues after the first page without dropping or duplicating equal-time rows", async () => {
    const first = await request(seeded.app.getHttpServer())
      .get("/notifications")
      .query({ limit: 100 })
      .set("Authorization", `Bearer ${bulkToken}`);
    expect(first.status).toBe(200);
    expect(first.body.hasMore).toBe(true);
    const cursor: unknown = first.body.nextCursor;
    if (typeof cursor !== "number")
      throw new Error("Notification continuation must return a numeric cursor");

    const second = await request(seeded.app.getHttpServer())
      .get("/notifications")
      .query({ limit: 100, cursor })
      .set("Authorization", `Bearer ${bulkToken}`);
    expect(second.status).toBe(200);
    expect(second.body.hasMore).toBe(false);
    expect(second.body.nextCursor).toBeNull();

    const ids: number[] = [];
    for (const response of [first, second]) {
      const data: unknown = response.body.data;
      if (!Array.isArray(data)) throw new Error("Notification page data must be an array");
      for (const item of data) {
        if (item === null || typeof item !== "object" || !("id" in item) || typeof item.id !== "number")
          throw new Error("Notification rows must expose numeric ids");
        ids.push(item.id);
      }
    }
    expect(ids).toHaveLength(105);
    expect(new Set(ids).size).toBe(105);
    expect([...ids].sort((a, b) => a - b)).toEqual([...bulkIds].sort((a, b) => a - b));
    expect(ids).not.toContain(neighbourNotifId);
    expect(ids).not.toContain(softDeleteId);
  });
});
