import request from "supertest";
import { eq } from "drizzle-orm";
import { orgModules, timesheetPeriods } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * TS-14. The period state machine, walked through the API.
 *
 * The transitions are all implemented — submit, recall, reopen, lock, unlock —
 * and none of them had a test. This walks the legal path and then attempts
 * every illegal transition from each state, asserting the refusal *code*: 409
 * for a state machine violation, 403 for acting on someone else's period. A
 * guard that started answering 500 would still satisfy "it threw".
 *
 * It also pins two behaviours that are surprising, and pins them as they are
 * rather than as the ticket wishes they were. See the tests at the bottom —
 * `lockPeriod` has no state guard, and no code path in this module ever writes
 * the period status `LOCKED` that the enum declares and `reopenPeriod` checks
 * for. Both are recorded as findings; changing either is a product decision
 * about what "locked" means, and the tests are written so that whoever makes
 * that decision has to change them deliberately.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=timesheets-period-lifecycle
 */

const WORKER_PERMISSIONS = ["timesheets:entries:view", "timesheets:entries:create"];
const BOSS_PERMISSIONS = [
  "timesheets:entries:view",
  "timesheets:entries:create",
  "timesheets:approvals:view",
  "timesheets:approvals:manage",
];

describe(`${SEEDED_HARNESS} timesheet period lifecycle`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let workerToken = "";
  let bossToken = "";
  let periodId = 0;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("worker", { permissionKeys: WORKER_PERMISSIONS })
      /** Standing OWNER, because `canActOnPeriod` lets an org owner approve any period. */
      .addMember("boss", { permissionKeys: BOSS_PERMISSIONS, standing: "OWNER" })
      .build();

    await seeded.seedDb
      .insert(orgModules)
      .values([
        { orgId: fixture.orgId, moduleKey: "timesheets", enabled: true },
        { orgId: fixture.orgId, moduleKey: "build", enabled: true },
      ])
      .onConflictDoNothing();

    const worker = fixture.members["worker"];
    const boss = fixture.members["boss"];
    if (!worker || !boss) throw new Error("fixture members missing");
    workerToken = await signSeededToken(worker.userId, fixture.orgId);
    bossToken = await signSeededToken(boss.userId, fixture.orgId);

    /** `GET current` is the only way a period comes into existence. */
    const current = await request(seeded.app.getHttpServer())
      .get("/timesheets/periods/current")
      .set("Authorization", `Bearer ${workerToken}`);
    expect(current.status).toBe(200);
    periodId = current.body.id ?? current.body.period?.id;
    expect(periodId).toBeGreaterThan(0);
  }, 240_000);

  afterAll(async () => {
    await fixture?.teardown();
    await seeded?.close();
  }, 60_000);

/**
 * A fresh key per call, always.
 *
 * `submit` and `approve` carry `@Idempotent`, which makes the
 * `Idempotency-Key` header REQUIRED: without it the interceptor answers 400,
 * and a 400 on a POST reads like a body validation failure rather than a
 * missing header. That cost the first run of this file six red tests.
 *
 * The key must also differ per call. A repeated key replays the first
 * response, so the "refuses a second submit" test would receive the *first*
 * submit's 200 and fail, having proved nothing about the state machine.
 */
  let keySeq = 0;
  const freshKey = (label: string) => `${label}-${periodId}-${++keySeq}`;

  const act = (verb: string, token: string, body: object = {}) =>
    request(seeded.app.getHttpServer())
      .post(`/timesheets/periods/${periodId}/${verb}`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", freshKey(verb))
      .send(body);

  const approve = (token: string) =>
    request(seeded.app.getHttpServer())
      .post(`/timesheets/approvals/${periodId}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", freshKey("approve"))
      .send({});

  const status = async () => {
    const [row] = await seeded.seedDb
      .select({ status: timesheetPeriods.status, lockedAt: timesheetPeriods.lockedAt })
      .from(timesheetPeriods)
      .where(eq(timesheetPeriods.id, periodId));
    return row;
  };

  it("starts OPEN", async () => {
    expect((await status())?.status).toBe("OPEN");
  }, 60_000);

  it("refuses to recall a period that was never submitted", async () => {
    const res = await act("recall", workerToken);
    expect(res.status).toBe(409);
    expect((await status())?.status).toBe("OPEN");
  }, 60_000);

  it("refuses to reopen a period that was never approved", async () => {
    const res = await act("reopen", bossToken);
    expect(res.status).toBe(409);
  }, 60_000);

  it("submits from OPEN", async () => {
    expect((await act("submit", workerToken)).status).toBe(200);
    expect((await status())?.status).toBe("SUBMITTED");
  }, 60_000);

  it("refuses a second submit", async () => {
    expect((await act("submit", workerToken)).status).toBe(409);
    expect((await status())?.status).toBe("SUBMITTED");
  }, 60_000);

  /** Ownership, not permission: the boss holds every timesheets key and still cannot submit for someone else. */
  it("refuses a submit by anyone but the period's owner, with 403 not 409", async () => {
    const res = await act("submit", bossToken);
    expect(res.status).toBe(403);
  }, 60_000);

  it("recalls a submitted period back to DRAFT", async () => {
    expect((await act("recall", workerToken)).status).toBe(200);
    expect((await status())?.status).toBe("DRAFT");
  }, 60_000);

  it("refuses a second recall", async () => {
    expect((await act("recall", workerToken)).status).toBe(409);
  }, 60_000);

  it("submits again from DRAFT", async () => {
    expect((await act("submit", workerToken)).status).toBe(200);
    expect((await status())?.status).toBe("SUBMITTED");
  }, 60_000);

  it("approves as the org owner", async () => {
    const res = await approve(bossToken);
    expect(res.status).toBe(200);
    expect((await status())?.status).toBe("APPROVED");
  }, 60_000);

  it("refuses to submit an approved period", async () => {
    expect((await act("submit", workerToken)).status).toBe(409);
  }, 60_000);

  it("reopens an approved period back to DRAFT", async () => {
    expect((await act("reopen", bossToken)).status).toBe(200);
    expect((await status())?.status).toBe("DRAFT");
  }, 60_000);

  /**
   * FINDING, pinned as-is. `lockPeriod` checks only that the period exists —
   * no state guard at all — so a DRAFT period that was never submitted or
   * approved can be locked, freezing the worker's entries without anyone
   * having approved them. Every other transition in this service guards its
   * source state. Whether "lock" means "after approval" or "freeze this
   * period now" is a product question; this test exists so that answering it
   * requires editing a test rather than discovering the behaviour later.
   */
  it("locks a DRAFT period, because lockPeriod has no state guard", async () => {
    expect((await act("lock", bossToken)).status).toBe(200);
    const row = await status();
    expect(row?.lockedAt).not.toBeNull();
    /** And the status does not become LOCKED — see the next test. */
    expect(row?.status).toBe("DRAFT");
  }, 60_000);

  /**
   * FINDING, pinned as-is. `timesheet_period_status` declares `LOCKED`, and
   * `reopenPeriod` accepts `["APPROVED", "LOCKED"]` — but nothing in this
   * module ever writes that status. `lockPeriod` stamps `lockedAt` and leaves
   * the status alone. So the LOCKED branch of reopen's guard is unreachable,
   * and a locked-but-not-approved period cannot be reopened; `unlock` is the
   * only way back out.
   */
  it("cannot reopen a locked DRAFT period, because its status is still DRAFT", async () => {
    expect((await act("reopen", bossToken)).status).toBe(409);
  }, 60_000);

  it("unlocks, which is the only way back out of that state", async () => {
    expect((await act("unlock", bossToken)).status).toBe(200);
    expect((await status())?.lockedAt).toBeNull();
  }, 60_000);
});
