import request from "supertest";
import { orgModules } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { formatDateOnly } from "src/modules/timesheets/core/lib/period.helpers";

/**
 * TS-13. The entry guards, through the API, with the settings that drive them
 * actually changed between assertions.
 *
 * Every one of these guards was implemented and none was tested. Two things
 * this file insists on:
 *
 *   1. **The refusal code, not just a refusal.** These are 400s. A guard that
 *      started answering 500 would still satisfy "the request failed", and a
 *      500 is a different bug wearing the same clothes.
 *   2. **That the setting is read.** Every guard is exercised twice — once
 *      refusing under one setting and once permitting under another. A guard
 *      that ignored its setting and always refused would pass a one-sided test
 *      and be indistinguishable from a working one.
 *
 * `today` comes from the same `formatDateOnly` the service uses, so the spec
 * and the code agree on which day it is even when the host is not UTC.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=timesheets-entry-validation
 */

const PERMISSIONS = [
  "timesheets:entries:view",
  "timesheets:entries:create",
  "timesheets:settings:view",
  "timesheets:settings:manage",
];

describe(`${SEEDED_HARNESS} timesheet entry validation`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token = "";

  const today = formatDateOnly(new Date());
  const shift = (days: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb).addMember("worker", { permissionKeys: PERMISSIONS }).build();
    await seeded.seedDb
      .insert(orgModules)
      .values([
        { orgId: fixture.orgId, moduleKey: "timesheets", enabled: true },
        { orgId: fixture.orgId, moduleKey: "build", enabled: true },
      ])
      .onConflictDoNothing();

    const worker = fixture.members["worker"];
    if (!worker) throw new Error("fixture member 'worker' missing");
    token = await signSeededToken(worker.userId, fixture.orgId);
  }, 240_000);

  afterAll(async () => {
    await fixture?.teardown();
    await seeded?.close();
  }, 60_000);

  /**
   * Every policy this file sets is *material* under TS-16, so the PATCH needs a
   * `changeReason` or it answers 400 — and a 400 here does not look like a
   * missing field, it looks like the validation rule under test rejecting a
   * legitimate value. That is how it read when TS-16 landed after this file was
   * written: ten tests went red across four unrelated describes, none of them
   * about settings.
   *
   * The reason is supplied here rather than at each call site so that adding a
   * field to `MATERIAL_FIELDS` cannot break this file again. The rule itself is
   * covered where it belongs — `settings-change-reason.spec.ts` for the
   * classification, and the attendance-draft seeded spec for the refusal
   * through the API.
   */
  const settings = (patch: object) =>
    request(seeded.app.getHttpServer())
      .patch("/timesheets/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ changeReason: "Entry-validation coverage", ...patch });

  const createEntry = (body: object) =>
    request(seeded.app.getHttpServer())
      .post("/timesheets/entries")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  it("accepts an ordinary entry for today", async () => {
    expect((await settings({ maxHoursPerDay: 24, allowFutureEntries: false, requiredFields: [] })).status).toBe(200);

    const res = await createEntry({ date: today, hours: 1, description: "baseline" });
    expect(res.status).toBe(201);
  }, 60_000);

  describe("future dates", () => {
    it("refuses a future entry with 400 when the setting is off", async () => {
      expect((await settings({ allowFutureEntries: false })).status).toBe(200);

      const res = await createEntry({ date: shift(3), hours: 1, description: "tomorrow's work" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/future/i);
    }, 60_000);

    it("accepts the same entry once the setting is on", async () => {
      expect((await settings({ allowFutureEntries: true })).status).toBe(200);

      const res = await createEntry({ date: shift(3), hours: 1, description: "tomorrow's work" });
      expect(res.status).toBe(201);

      await settings({ allowFutureEntries: false });
    }, 60_000);
  });

  describe("the backdate limit", () => {
    /**
     * The boundary is the point. Before `wholeDaysBetween`, the check compared
     * a UTC midnight against a LOCAL noon, so a limit of 3 admitted four days
     * in UTC and India and three in UTC+14 — the same setting meaning
     * different things per machine. Exactly at the limit must pass and one
     * past it must fail, here and on any host.
     */
    beforeAll(async () => {
      expect((await settings({ allowBackdatedEntries: true, backdateLimitDays: 3 })).status).toBe(200);
    });

    it("accepts an entry exactly at the limit", async () => {
      const res = await createEntry({ date: shift(-3), hours: 1, description: "three days ago" });
      expect(res.status).toBe(201);
    }, 60_000);

    it("refuses an entry one day past the limit, and says so", async () => {
      const res = await createEntry({ date: shift(-4), hours: 1, description: "four days ago" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/3 days in the past/);
    }, 60_000);

    it("refuses any backdating at all when backdating is off", async () => {
      expect((await settings({ allowBackdatedEntries: false })).status).toBe(200);

      const res = await createEntry({ date: shift(-1), hours: 1, description: "yesterday" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/backdated/i);

      await settings({ allowBackdatedEntries: true });
    }, 60_000);
  });

  /**
   * FINDING, and the reason these tests are shaped the way they are.
   *
   * `timesheets` carries three partial unique indexes and the widest of them,
   * `uniq_timesheets_work_log` — `(org_id, user_id, date) WHERE ticket_id IS
   * NULL` — allows exactly one ticket-less entry per person per day. It
   * subsumes the two beside it: `uniq_timesheets_day_project` exists to allow
   * one entry per project per day, and it can never come into play, because
   * two entries on one day collide on the wider index first whatever their
   * projects are. It also omits `voided_at IS NULL`, so voiding an entry does
   * not free the day.
   *
   * The index comes from the HR work-log path, which upserts one row per
   * person per day. Whether the whole timesheets module should inherit that
   * rule is a question for the two modules' owners; it is recorded, not
   * changed.
   *
   * What WAS fixed is the answer. A second entry raised 23505 and reached the
   * client as a 500 — an ordinary user action answered with "internal server
   * error" and an alert. It is now a 409 that says what happened.
   */
  describe("one entry per day, and the daily cap", () => {
    const capDay = () => shift(-2);

    it("accepts the first entry of a day", async () => {
      expect((await settings({ maxHoursPerDay: 8, backdateLimitDays: 3 })).status).toBe(200);

      const res = await createEntry({ date: capDay(), hours: 6, description: "morning" });
      expect(res.status).toBe(201);
    }, 60_000);

    it("answers 409 for a second entry on the same day, not 500", async () => {
      const res = await createEntry({ date: capDay(), hours: 1, description: "afternoon" });

      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/already exists for/);
    }, 60_000);

    /**
     * The cap still guards a single entry, and it is checked before the insert
     * — so this is a 400 about hours rather than the 409 about the day.
     */
    it("refuses a single entry that exceeds the cap on its own, with 400", async () => {
      const res = await createEntry({ date: shift(-1), hours: 9, description: "a long day" });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/daily limit of 8/);
    }, 60_000);

    it("accepts exactly the cap", async () => {
      const res = await createEntry({ date: shift(-1), hours: 8, description: "a full day" });
      expect(res.status).toBe(201);
    }, 60_000);
  });

  describe("required fields", () => {
    it("refuses a missing description once it is required", async () => {
      /**
       * A wider backdate window and a day no other test has touched: one
       * ticket-less entry per day is the rule, so every case in this file needs
       * its own date. Which is itself a fair demonstration of the finding above.
       */
      expect(
        (await settings({ requiredFields: ["description"], maxHoursPerDay: 24, backdateLimitDays: 10 }))
          .status,
      ).toBe(200);

      const res = await createEntry({ date: shift(-6), hours: 1 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/description/i);
    }, 60_000);

    it("accepts the same entry with the field supplied", async () => {
      /** The same untouched day, now with the field the settings demand. */
      const res = await createEntry({ date: shift(-6), hours: 1, description: "now described" });
      expect(res.status).toBe(201);

      await settings({ requiredFields: [] });
    }, 60_000);
  });
});
