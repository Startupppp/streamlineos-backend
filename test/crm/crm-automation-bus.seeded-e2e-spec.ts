import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  crmAutomationEvents,
  crmAutomationRules,
  crmAutomationRuns,
  orgModules,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { CrmAutomationBusService } from "src/modules/crm/automation-studio/crm-automation-bus.service";

/**
 * The automation studio's trigger, from where production actually pulls it.
 *
 * `deals.service` fires this as `void this.bus.emit(...)`, so by the time the
 * bus reads `crm_automation_events` and `crm_automation_rules` the request's
 * tenant transaction has committed and closed. Both tables are behind
 * `tenant_isolation`, whose read predicate raises with no tenant context — so
 * the read did not return "no rules", it threw, into a `.catch` that logged it
 * somewhere nobody reads. Every automation rule in the product was dead, and
 * the studio UI showed rules that would never run.
 *
 * That is the third instance of one bug: the WhatsApp seam, the outbound
 * webhook dispatcher, and this. All three are invisible to a unit test with a
 * `Db` double, because a double has no policies. So this file emits the way
 * production emits — detached, with no ambient transaction — and then looks for
 * the run row.
 *
 * Run with:
 *   NODE_OPTIONS=--max-old-space-size=12288 \
 *   APP_DATABASE_URL=postgres://streamline_app:...@host/db \
 *   pnpm test:e2e:seeded --testPathPattern="crm-automation-bus"
 */

describe(`${SEEDED_HARNESS} CRM automation bus — a detached emit still reaches its rules`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let ruleId: string;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb).addMember("rep").build();
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true });

    /**
     * The event has to be registered and active, because the bus refuses an
     * unknown key before it ever looks for a rule — so a fixture that skipped
     * this would pass for the wrong reason.
     */
    await seeded.seedDb
      .insert(crmAutomationEvents)
      .values({
        orgId: fixture.orgId,
        key: "deal.won",
        label: "Deal won",
        entityType: "deal",
        isActive: true,
      });

    const [rule] = await seeded.seedDb
      .insert(crmAutomationRules)
      .values({
        orgId: fixture.orgId,
        name: "Seeded — on deal won",
        trigger: "deal.won",
        isActive: true,
        cooldownMinutes: 0,
        graph: [],
        conditions: [],
        actions: [],
      })
      .returning({ id: crmAutomationRules.id });
    if (!rule) throw new Error("seed: automation rule insert failed");
    ruleId = rule.id;
  }, 180_000);

  afterAll(async () => {
    if (fixture) await fixture.teardown();
    if (seeded) await seeded.close();
  }, 60_000);

  const runsForRule = () =>
    seeded.seedDb
      .select({ id: crmAutomationRuns.id, status: crmAutomationRuns.status })
      .from(crmAutomationRuns)
      .where(
        and(
          eq(crmAutomationRuns.orgId, fixture.orgId),
          eq(crmAutomationRuns.ruleId, ruleId),
        ),
      );

  it(
    "records a run when the event is emitted with no ambient transaction",
    async () => {
      expect(await runsForRule()).toHaveLength(0);

      /**
       * Off the container, detached, exactly as `deals.service` fires it. Not a
       * shortcut past HTTP — `void this.bus.emit(...)` means the work happens
       * after the response either way, so this IS the production condition.
       */
      await seeded.app.get(CrmAutomationBusService).emit(fixture.orgId, "deal.won", {
        entityType: "deal",
        entityId: "4242",
        data: { value: "120000" },
      });

      for (let pass = 0; pass < 20 && (await runsForRule()).length === 0; pass += 1)
        await new Promise((resolve) => setTimeout(resolve, 250));

      expect(await runsForRule()).toHaveLength(1);
    },
    120_000,
  );

  it(
    "still refuses an event key this organisation has not registered",
    async () => {
      const before = (await runsForRule()).length;

      await seeded.app.get(CrmAutomationBusService).emit(fixture.orgId, "deal.imaginary", {
        entityType: "deal",
        entityId: "4243",
        data: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await runsForRule()).toHaveLength(before);
    },
    120_000,
  );

  /**
   * The tenant fence, on the path that now opens its own transaction. A bus
   * that entered the wrong tenant, or none, would either find another
   * organisation's rules or find nothing — and "found nothing" is the failure
   * this whole file exists to make visible.
   */
  it(
    "finds no rules for an organisation that has none",
    async () => {
      const other = await seedOrg(seeded.seedDb).addMember("rep").build();
      try {
        await seeded.app.get(CrmAutomationBusService).emit(other.orgId, "deal.won", {
          entityType: "deal",
          entityId: "4244",
          data: {},
        });

        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const rows = await seeded.seedDb
          .select({ id: crmAutomationRuns.id })
          .from(crmAutomationRuns)
          .where(eq(crmAutomationRuns.orgId, other.orgId));
        expect(rows).toEqual([]);
      } finally {
        await other.teardown();
      }
    },
    120_000,
  );
});
