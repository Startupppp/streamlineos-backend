import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  customerHealthAssessments,
  customerLifecycleSignals,
  customerLifecycleTriggers,
  customerLifecycles,
  deals,
  orgModules,
} from "src/db/schema";
import { businessParties } from "src/db/schema/party";
import { LifecycleTriggersService } from "src/modules/lifecycle/lifecycle-triggers.service";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P2-07. The customer said they wanted more, and the book could not act on
 * it.
 *
 * `expansion-interest` has been a first-class lifecycle signal since the risk
 * model shipped — worth -20 against churn — and nothing opened a conversation
 * off it. For an annual contract that is up to a year of silence after somebody
 * raised their hand.
 *
 * The decision itself has unit coverage; what this file proves is the half a
 * unit test cannot see. The candidate query's `due` predicate had three arms and
 * all three were about revenue leaving, so a healthy customer with a renewal a
 * year out was never loaded. Without a fourth arm the expansion branch would be
 * unreachable in production while passing every unit test, because the row it
 * decides on would never be selected — the exact shape of "inert while looking
 * finished".
 *
 * The party is deliberately unreachable, so `judgeOutbound` refuses at
 * eligibility before any provider call. The trigger row still has to exist, and
 * with the right kind: opening the conversation and drafting the message are
 * separate acts, and this ticket is about the first.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-expansion-trigger
 */

const DAY_MS = 86_400_000;

describe(`${SEEDED_HARNESS} a customer who asked for more gets a conversation`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let triggers: LifecycleTriggersService;
  let ownerUserId = "";
  let partyId = "";
  let dealId = 0;
  let customerLifecycleId = "";

  const asOf = new Date("2026-09-09T09:00:00.000Z");
  const iso = (date: Date) => date.toISOString().slice(0, 10);

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("owner-rep", { permissionKeys: ["crm:deals:read", "crm:deals:create"] })
      .build();
    triggers = seeded.app.get(LifecycleTriggersService);
    ownerUserId = fixture.members["owner-rep"]!.userId;

    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true })
      .onConflictDoNothing();

    partyId = randomUUID();
    await seeded.seedDb.insert(businessParties).values({
      partyId,
      organizationId: fixture.orgId,
      name: "Expansion probe",
      /** No address on file, so the loop refuses before it spends anything. */
    });

    const [deal] = await seeded.seedDb
      .insert(deals)
      .values({
        orgId: fixture.orgId,
        name: "Expansion probe — original",
        stage: "won",
        partyId,
        assignedToId: ownerUserId,
      })
      .returning({ id: deals.id });
    dealId = deal!.id;

    customerLifecycleId = randomUUID();
    await seeded.seedDb.insert(customerLifecycles).values({
      customerLifecycleId,
      organizationId: fixture.orgId,
      partyId,
      sourceDealId: dealId,
      status: "active",
      /** A renewal a long way off: nothing else could be opening a conversation. */
      startedOn: iso(new Date(asOf.getTime() - 60 * DAY_MS)),
      termMonths: 24,
      renewalOn: iso(new Date(asOf.getTime() + 500 * DAY_MS)),
      riskScore: 0,
    });

    /**
     * A health band, and it is not scaffolding.
     *
     * `EXPANSION_HEALTH_BANDS` excludes null on purpose — selling more into a
     * customer nobody can score is a person's decision — so a fixture with no
     * assessment would stand down for the right reason and prove nothing about
     * the branch. Discovered by running it: the first draft of this file had no
     * assessment and reported `not-due`.
     */
    await seeded.seedDb.insert(customerHealthAssessments).values({
      organizationId: fixture.orgId,
      partyId,
      score: 82,
      healthStatus: "healthy",
      coverageBps: 10_000,
      weightsVersion: 1,
    });
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(customerLifecycleTriggers)
        .where(eq(customerLifecycleTriggers.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(customerLifecycleSignals)
        .where(eq(customerLifecycleSignals.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(customerHealthAssessments)
        .where(eq(customerHealthAssessments.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(customerLifecycles)
        .where(eq(customerLifecycles.organizationId, fixture.orgId));
      await seeded.seedDb.delete(deals).where(eq(deals.orgId, fixture.orgId));
      await seeded.seedDb
        .delete(businessParties)
        .where(eq(businessParties.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(orgModules)
        .where(eq(orgModules.orgId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  const sweep = () =>
    runInNewTenantTransaction(seeded.seedDb, fixture.orgId, () =>
      triggers.sweep(fixture.orgId, { asOf, limit: 25 }),
    );

  const storedTriggers = () =>
    seeded.seedDb
      .select({
        kind: customerLifecycleTriggers.kind,
        dueOn: customerLifecycleTriggers.dueOn,
        outcome: customerLifecycleTriggers.outcome,
        refusalStage: customerLifecycleTriggers.refusalStage,
      })
      .from(customerLifecycleTriggers)
      .where(
        and(
          eq(customerLifecycleTriggers.organizationId, fixture.orgId),
          eq(customerLifecycleTriggers.customerLifecycleId, customerLifecycleId),
        ),
      );

  it("does not consider a healthy customer whose renewal is a year out", async () => {
    /**
     * The state the old predicate left unreachable, asserted first so the test
     * below is a change and not a coincidence.
     */
    const report = await sweep();
    expect(report.considered).toBe(0);
    expect(await storedTriggers()).toHaveLength(0);
  }, 120_000);

  it("loads and opens the same customer once they have asked for more", async () => {
    await seeded.seedDb.insert(customerLifecycleSignals).values({
      organizationId: fixture.orgId,
      customerLifecycleId,
      kind: "expansion-interest",
      impact: -20,
      observedAt: new Date(asOf.getTime() - 3 * DAY_MS),
    });

    const report = await sweep();
    expect(report.considered).toBe(1);
    expect(report.opened).toBe(1);

    const [row] = await storedTriggers();
    expect(row!.kind).toBe("expansion-ready");
    /** The day they said it, not the day the sweep noticed. */
    expect(row!.dueOn).toBe(iso(new Date(asOf.getTime() - 3 * DAY_MS)));
    /**
     * The loop refused for want of an address, which is the correct answer for
     * this fixture — and the trigger exists anyway. Opening the conversation and
     * drafting the message are separate acts.
     */
    expect(row!.outcome).toBe("skipped");
    expect(row!.refusalStage).toBe("eligibility");
  }, 180_000);

  it("names the opportunity an expansion rather than a renewal", async () => {
    /**
     * The row lands in a rep's deal list beside ordinary new business. An
     * expansion labelled as a renewal hides revenue that genuinely is new.
     */
    const opened = await seeded.seedDb
      .select({ name: deals.name })
      .from(deals)
      .where(and(eq(deals.orgId, fixture.orgId), eq(deals.partyId, partyId)));

    expect(opened.map((row) => row.name)).toContain("Expansion — Expansion probe");
  }, 120_000);

  it("lets a stale interest go rather than acting on it months later", async () => {
    /**
     * A separate lifecycle, because the one above now carries a trigger and
     * would be re-offered on its own account.
     */
    const [otherDeal] = await seeded.seedDb
      .insert(deals)
      .values({
        orgId: fixture.orgId,
        name: "Stale probe — original",
        stage: "won",
        partyId,
        assignedToId: ownerUserId,
      })
      .returning({ id: deals.id });

    const staleLifecycleId = randomUUID();
    await seeded.seedDb.insert(customerLifecycles).values({
      customerLifecycleId: staleLifecycleId,
      organizationId: fixture.orgId,
      partyId,
      sourceDealId: otherDeal!.id,
      status: "active",
      startedOn: iso(new Date(asOf.getTime() - 300 * DAY_MS)),
      termMonths: 24,
      renewalOn: iso(new Date(asOf.getTime() + 400 * DAY_MS)),
      riskScore: 0,
    });
    await seeded.seedDb.insert(customerLifecycleSignals).values({
      organizationId: fixture.orgId,
      customerLifecycleId: staleLifecycleId,
      kind: "expansion-interest",
      impact: -20,
      /** Outside the window: history, not an opening. */
      observedAt: new Date(asOf.getTime() - 200 * DAY_MS),
    });

    const report = await sweep();
    const opened = await seeded.seedDb
      .select({ kind: customerLifecycleTriggers.kind })
      .from(customerLifecycleTriggers)
      .where(
        and(
          eq(customerLifecycleTriggers.organizationId, fixture.orgId),
          eq(customerLifecycleTriggers.customerLifecycleId, staleLifecycleId),
        ),
      );

    expect(opened).toHaveLength(0);
    /** And the stale one was never even loaded, so it cost nothing to skip. */
    expect(report.entries.every((entry) => entry.customerLifecycleId !== staleLifecycleId)).toBe(
      true,
    );
  }, 180_000);

  it("says nothing about a customer the health model could not score", async () => {
    /**
     * Not an omission. Selling more into a customer nobody can score is a
     * decision a person should make, and this is the branch that keeps an
     * unscored account out of an automated upsell.
     */
    await seeded.seedDb
      .delete(customerHealthAssessments)
      .where(eq(customerHealthAssessments.organizationId, fixture.orgId));
    await seeded.seedDb
      .delete(customerLifecycleTriggers)
      .where(eq(customerLifecycleTriggers.organizationId, fixture.orgId));

    const report = await sweep();

    /** Still loaded — the interest is real — and still declined. */
    expect(report.considered).toBe(1);
    expect(report.opened).toBe(0);
    expect(report.entries[0]?.reason).toBe("not-due");
  }, 120_000);
});
