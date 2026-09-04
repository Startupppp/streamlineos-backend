import { eq } from "drizzle-orm";
import request from "supertest";
import { notifications } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Every notification row is addressed to exactly one membership (`membership_id`). The
 * `NotificationsService.markRead` call binds `orgId` and `userId` from the JWT so the
 * recipient is always the authenticated caller — a client cannot supply a foreign id.
 * The authorization decision is object-level: the service looks up the notification by
 * `(orgId, membershipId, notificationId)` and throws `NotFoundException` when the triple
 * doesn't match, returning 404 regardless of whether the mismatch is same-org/wrong-user
 * or cross-tenant.
 *
 * This file asks three questions the mocked suites cannot:
 *
 *   deny          a member of the same org who is NOT the addressee gets 404 on
 *                 `PATCH /notifications/:notificationId/read`, and `is_read` stays false
 *   cross-tenant  a member of org B gets 404 when using org A's notification id, and the
 *                 row is re-read from the database to prove `is_read` did not change
 *   allow         the actual recipient can mark the notification as read, and `is_read`
 *                 becomes true — proving the mechanism works and the denial is not a
 *                 blanket 404 on every request
 *
 * WHAT THIS FILE DOES *NOT* PROVE. The `notifications` table carries an RLS policy.
 * Deleting the `membershipId` predicate from `NotificationsService.markRead` may still
 * leave the deny cases green if the policy supplies the recipient predicate independently.
 * Attribution of the same-org refusal to the service's own SQL belongs to a unit test
 * that compiles the query and asserts the predicate. The cross-tenant integrity assertion
 * below is attributable here: a policy keyed on `org_id = current_org_id()` prevents a
 * cross-tenant UPDATE regardless of the service predicate, so the `is_read` check would
 * pass either way. The value of that assertion is proving the DEPLOYED SYSTEM refuses,
 * which is the question the existing mocked notification suites cannot ask.
 *
 * The `notifications` routes are all `@Universal()` — no permission key is granted to
 * the seeded members and none is needed. The `markRead` handler carries no `@Idempotent`
 * decorator, so no `Idempotency-Key` header is required.
 */
describe("[seeded-e2e] Notifications — recipient isolation", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let notificationId = 0;
  let recipientToken = "";
  let otherToken = "";
  let neighbourToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("recipient")
      .addMember("other")
      .build();
    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("member")
      .build();

    const [notifRow] = await seeded.seedDb
      .insert(notifications)
      .values({
        orgId: home.orgId,
        membershipId: home.members.recipient.membershipId,
        title: "You have a new task",
        message: "A task was assigned to you",
      })
      .returning({ id: notifications.id });
    notificationId = notifRow?.id ?? 0;

    recipientToken = await signSeededToken(
      seeded,
      home.members.recipient.userId,
      home.orgId,
    );
    otherToken = await signSeededToken(
      seeded,
      home.members.other.userId,
      home.orgId,
    );
    neighbourToken = await signSeededToken(
      seeded,
      neighbour.members.member.userId,
      neighbour.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (notificationId > 0)
      await seeded.seedDb
        .delete(notifications)
        .where(eq(notifications.id, notificationId));
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  async function isReadState(): Promise<boolean> {
    const [row] = await seeded.seedDb
      .select({ isRead: notifications.isRead })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    return row?.isRead ?? false;
  }

  it("fixture check — the two organisations are distinct and the notification was inserted", () => {
    expect(notificationId).toBeGreaterThan(0);
    expect(home.orgId).not.toBe(neighbour.orgId);
  });

  it("DENY (same org, wrong user) — another member cannot mark the notification as read, and isRead stays false", async () => {
    expect(await isReadState()).toBe(false);

    const response = await request(server as never)
      .patch(`/notifications/${String(notificationId)}/read`)
      .set("Authorization", `Bearer ${otherToken}`);

    expect(response.status).toBe(404);
    expect(await isReadState()).toBe(false);
  });

  it("CROSS-TENANT — a member of another org cannot mark the notification as read, and the row is unchanged", async () => {
    const response = await request(server as never)
      .patch(`/notifications/${String(notificationId)}/read`)
      .set("Authorization", `Bearer ${neighbourToken}`);

    expect(response.status).toBe(404);
    expect(await isReadState()).toBe(false);
  });

  it("ALLOW — the recipient marks their own notification as read, and isRead becomes true", async () => {
    const response = await request(server as never)
      .patch(`/notifications/${String(notificationId)}/read`)
      .set("Authorization", `Bearer ${recipientToken}`);

    expect(response.status).toBe(200);
    expect(await isReadState()).toBe(true);
  });
});
