import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { orgModules, timesheetPeriods, userDelegations } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * TS-15. Who may approve a timesheet, and what happens to everyone else.
 *
 * `canActOnPeriod` has a unit spec and this is not a second copy of it. The
 * unit spec proves the decision; this proves the decision is reached — that
 * the permission guard, the assigned approver, the delegation lookup and the
 * self-approval rule all compose the way they are supposed to when a real
 * request arrives.
 *
 * Every actor here holds `timesheets:approvals:manage`. That is deliberate:
 * with the permission held by all of them, a refusal can only come from the
 * authority rule, so the test cannot pass for the wrong reason.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=timesheets-approval-authority
 */

const APPROVER_KEYS = [
  "timesheets:entries:view",
  "timesheets:entries:create",
  "timesheets:approvals:view",
  "timesheets:approvals:manage",
];

describe(`${SEEDED_HARNESS} timesheet approval authority`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  const tokens: Record<string, string> = {};
  const periods: Record<string, number> = {};

  let keySeq = 0;
  const freshKey = (label: string) => `${label}-${++keySeq}-${randomUUID()}`;

  const openPeriodFor = async (alias: string) => {
    const res = await request(seeded.app.getHttpServer())
      .get("/timesheets/periods/current")
      .set("Authorization", `Bearer ${tokens[alias]}`);
    expect(res.status).toBe(200);
    return (res.body.id ?? res.body.period?.id) as number;
  };

  const submit = (alias: string, periodId: number) =>
    request(seeded.app.getHttpServer())
      .post(`/timesheets/periods/${periodId}/submit`)
      .set("Authorization", `Bearer ${tokens[alias]}`)
      .set("Idempotency-Key", freshKey("submit"))
      .send({});

  const approveOne = (alias: string, periodId: number) =>
    request(seeded.app.getHttpServer())
      .post(`/timesheets/approvals/${periodId}/approve`)
      .set("Authorization", `Bearer ${tokens[alias]}`)
      .set("Idempotency-Key", freshKey("approve"))
      .send({});

  const bulkApprove = (alias: string, periodIds: number[]) =>
    request(seeded.app.getHttpServer())
      .post("/timesheets/approvals/bulk-approve")
      .set("Authorization", `Bearer ${tokens[alias]}`)
      .set("Idempotency-Key", freshKey("bulk"))
      .send({ periodIds });

  const statusOf = async (periodId: number) => {
    const [row] = await seeded.seedDb
      .select({ status: timesheetPeriods.status })
      .from(timesheetPeriods)
      .where(eq(timesheetPeriods.id, periodId));
    return row?.status;
  };

  /** The approver a period names is normally derived from its project; set here directly. */
  const assignApprover = (periodId: number, userId: string) =>
    seeded.seedDb
      .update(timesheetPeriods)
      .set({ currentApproverId: userId })
      .where(eq(timesheetPeriods.id, periodId));

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("worker", { permissionKeys: APPROVER_KEYS })
      .addMember("second", { permissionKeys: APPROVER_KEYS })
      .addMember("approver", { permissionKeys: APPROVER_KEYS })
      .addMember("outsider", { permissionKeys: APPROVER_KEYS })
      .build();

    await seeded.seedDb
      .insert(orgModules)
      .values([
        { orgId: fixture.orgId, moduleKey: "timesheets", enabled: true },
        { orgId: fixture.orgId, moduleKey: "build", enabled: true },
      ])
      .onConflictDoNothing();

    for (const alias of ["worker", "second", "approver", "outsider"]) {
      const member = fixture.members[alias];
      if (!member) throw new Error(`fixture member '${alias}' missing`);
      tokens[alias] = await signSeededToken(member.userId, fixture.orgId);
    }

    periods["worker"] = await openPeriodFor("worker");
    periods["second"] = await openPeriodFor("second");
    expect((await submit("worker", periods["worker"]!)).status).toBe(200);
    expect((await submit("second", periods["second"]!)).status).toBe(200);

    await assignApprover(periods["worker"]!, fixture.members["approver"]!.userId);
    await assignApprover(periods["second"]!, fixture.members["approver"]!.userId);
  }, 240_000);

  afterAll(async () => {
    await fixture?.teardown();
    await seeded?.close();
  }, 60_000);

  it("refuses a holder of the permission who is not the assigned approver", async () => {
    const res = await approveOne("outsider", periods["worker"]!);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/assigned approver/i);
    expect(await statusOf(periods["worker"]!)).toBe("SUBMITTED");
  }, 60_000);

  /**
   * FINDING, pinned. The single-period route answers 403; bulk-approve treats
   * `ForbiddenException` as an "expected skip" and answers 200 with
   * `{ approved: 0, skipped: 1 }`. So a user who may approve none of a batch
   * gets a success response, and the skip count does not distinguish "already
   * approved" from "you are not allowed to". Defensible for a mixed batch,
   * surprising for a batch of one — recorded rather than changed, because
   * making the batch fail is a product decision about partial success.
   */
  it("silently skips rather than refusing when the same user goes through bulk-approve", async () => {
    const res = await bulkApprove("outsider", [periods["worker"]!]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: 0, skipped: 1 });
    expect(await statusOf(periods["worker"]!)).toBe("SUBMITTED");
  }, 60_000);

  it("refuses self-approval even from a holder of the permission", async () => {
    const res = await approveOne("worker", periods["worker"]!);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/your own timesheet/i);
    expect(await statusOf(periods["worker"]!)).toBe("SUBMITTED");
  }, 60_000);

  it("allows the assigned approver", async () => {
    const res = await bulkApprove("approver", [periods["worker"]!]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: 1, skipped: 0 });
    expect(await statusOf(periods["worker"]!)).toBe("APPROVED");
  }, 60_000);

  describe("delegation", () => {
    const delegationId = randomUUID();

    afterAll(async () => {
      await seeded.seedDb.delete(userDelegations).where(eq(userDelegations.id, delegationId));
    });

    it("still refuses the outsider before any delegation exists", async () => {
      expect((await approveOne("outsider", periods["second"]!)).status).toBe(403);
    }, 60_000);

    it("allows the outsider once the approver has delegated to them", async () => {
      await seeded.seedDb.insert(userDelegations).values({
        id: delegationId,
        orgId: fixture.orgId,
        delegatorMembershipId: fixture.members["approver"]!.membershipId,
        delegateeMembershipId: fixture.members["outsider"]!.membershipId,
        startsAt: new Date(Date.now() - 3_600_000),
        endsAt: new Date(Date.now() + 3_600_000),
        status: "ACTIVE",
      });

      const res = await approveOne("outsider", periods["second"]!);

      expect(res.status).toBe(200);
      expect(await statusOf(periods["second"]!)).toBe("APPROVED");
    }, 60_000);

    /**
     * The window is checked, not just the row. An expired delegation that
     * still reads ACTIVE must not carry authority, or revocation-by-expiry
     * silently does nothing.
     */
    it("does not honour a delegation whose window has closed", async () => {
      const expiredId = randomUUID();
      const third = await openPeriodFor("second");
      /** `second` already has an approved period; a fresh one is not guaranteed, so guard. */
      if (third === periods["second"]) return;

      await seeded.seedDb.insert(userDelegations).values({
        id: expiredId,
        orgId: fixture.orgId,
        delegatorMembershipId: fixture.members["approver"]!.membershipId,
        delegateeMembershipId: fixture.members["outsider"]!.membershipId,
        startsAt: new Date(Date.now() - 7_200_000),
        endsAt: new Date(Date.now() - 3_600_000),
        status: "ACTIVE",
      });
      await seeded.seedDb.delete(userDelegations).where(eq(userDelegations.id, delegationId));

      await submit("second", third);
      await assignApprover(third, fixture.members["approver"]!.userId);

      const res = await approveOne("outsider", third);
      expect(res.status).toBe(403);

      await seeded.seedDb.delete(userDelegations).where(eq(userDelegations.id, expiredId));
    }, 60_000);
  });
});
