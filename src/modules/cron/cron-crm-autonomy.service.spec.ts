/**
 * `forEachOrg` opens a real tenant transaction per organisation, which needs a
 * database. Stubbed to run the callback for a fixed pair of organisations, so
 * these tests are about what the sweep decides rather than about tenancy — which
 * `for-each-org` has its own tests for.
 */
jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(
    async (
      _db: unknown,
      _sweep: string,
      fn: (tx: unknown, orgId: string) => Promise<void>,
    ) => {
      for (const orgId of ["org-a", "org-b"]) await fn({}, orgId);
      return { organizations: 2, succeeded: 2, failed: 0 };
    },
  ),
}));

import type { Db } from "../../db/drizzle.module";
import type { AutonomyRepairService } from "../autonomy/autonomy-repair.service";
import type { OutboundService } from "../autonomy/outbound.service";
import type { RelationshipStateService } from "../relationships/relationship-state.service";
import { MAX_REPAIRS_PER_DECISION } from "../autonomy/dto/autonomy-review.schemas";
import { NUDGE_AFTER_DAYS } from "../autonomy/outbound-eligibility";
import { CronCrmAutonomyService } from "./cron-crm-autonomy.service";

const partyAnchored = (partyId: string) => ({
  relationshipStateId: `rel-${partyId}`,
  anchor: { kind: "party" as const, partyId },
  state: {} as never,
});

const dealAnchored = (dealId: string) => ({
  relationshipStateId: `rel-${dealId}`,
  anchor: { kind: "deal" as const, dealId },
  state: {} as never,
});

function makeService(options: {
  quiet?: unknown[];
  composeOutcomes?: { held: boolean }[];
  repairOutcome?: { repaired: number; leftForAPerson: number };
}) {
  const listAwaitingReply = jest.fn().mockResolvedValue(options.quiet ?? []);
  const outcomes = [...(options.composeOutcomes ?? [])];
  const composeAndHold = jest
    .fn()
    .mockImplementation(async () => outcomes.shift() ?? { held: false, reason: "not due" });
  const runRepairs = jest
    .fn()
    .mockResolvedValue(options.repairOutcome ?? { repaired: 0, leftForAPerson: 0, classes: [] });

  const service = new CronCrmAutonomyService(
    {} as unknown as Db,
    { listAwaitingReply } as unknown as RelationshipStateService,
    { composeAndHold } as unknown as OutboundService,
    { runRepairs } as unknown as AutonomyRepairService,
  );

  return { service, listAwaitingReply, composeAndHold, runRepairs };
}

describe("CronCrmAutonomyService.sweepSilentRelationships", () => {
  /**
   * The cutoff is the shorter of the two thresholds `judgeOutbound` applies, and
   * it is imported rather than restated. A sweep with its own copy of the number
   * either misses deals that are due or pays to load and refuse ones that are
   * not, and the two drift the first time either is tuned.
   */
  it("asks for relationships quiet since the nudge threshold, not a number of its own", async () => {
    const { service, listAwaitingReply } = makeService({});
    const before = Date.now();

    await service.sweepSilentRelationships();

    const [, olderThan] = listAwaitingReply.mock.calls[0] as [string, Date, number];
    const expected = before - NUDGE_AFTER_DAYS * 86_400_000;
    // Within a second of the threshold, computed against the test's own clock.
    expect(Math.abs(olderThan.getTime() - expected)).toBeLessThan(1_000);
  });

  it("hands every quiet party to the outbound loop and tallies what it did", async () => {
    const { service, composeAndHold } = makeService({
      quiet: [partyAnchored("party-1"), partyAnchored("party-2")],
      composeOutcomes: [{ held: true }, { held: false }],
    });

    const result = await service.sweepSilentRelationships();

    // Two organisations, two candidates each.
    expect(composeAndHold).toHaveBeenCalledTimes(4);
    expect(composeAndHold).toHaveBeenCalledWith({ organizationId: "org-a", partyId: "party-1" });
    expect(result).toMatchObject({ organizations: 2, failed: 0, considered: 4 });
  });

  /**
   * `composeAndHold` addresses a party. A relationship anchored to a deal has
   * nobody to write to, and passing it would be a call that can only be refused.
   */
  it("skips a relationship anchored to a deal rather than a party", async () => {
    const { service, composeAndHold } = makeService({
      quiet: [dealAnchored("7")],
    });

    const result = await service.sweepSilentRelationships();

    expect(composeAndHold).not.toHaveBeenCalled();
    expect(result.considered).toBe(0);
  });

  /**
   * The sweep decides who to consider; `judgeOutbound` decides whether to act.
   * A refusal is the ordinary case — most quiet relationships are not due — and
   * must not read as a failure.
   */
  it("counts a refusal as a refusal, not a failure", async () => {
    const { service } = makeService({
      quiet: [partyAnchored("party-1")],
      composeOutcomes: [{ held: false }, { held: false }],
    });

    const result = await service.sweepSilentRelationships();

    expect(result).toMatchObject({ considered: 2, held: 0, refused: 2, failed: 0 });
  });
});

describe("CronCrmAutonomyService.runFieldRepairs", () => {
  /**
   * The limit has a default, but it lives on the Zod schema and only applies to
   * requests that came through the route. Calling the service directly with `{}`
   * hands `runOneClass` an undefined LIMIT.
   */
  it("passes the limit explicitly, because the schema default cannot reach it", async () => {
    const { service, runRepairs } = makeService({});

    await service.runFieldRepairs();

    expect(runRepairs).toHaveBeenCalledWith("org-a", { limit: MAX_REPAIRS_PER_DECISION });
  });

  /**
   * No `classes` argument. Every class is still asked separately whether this
   * tenant allows it, so the tenant's policy decides what happens — not the
   * scheduler's argument list.
   */
  it("names no classes, leaving the choice to each tenant's policy", async () => {
    const { service, runRepairs } = makeService({});

    await service.runFieldRepairs();

    expect(runRepairs.mock.calls[0]![1]).not.toHaveProperty("classes");
  });

  it("reports what was repaired and what was left for a person", async () => {
    const { service } = makeService({
      repairOutcome: { repaired: 3, leftForAPerson: 2 },
    });

    const result = await service.runFieldRepairs();

    // Summed across both organisations.
    expect(result).toMatchObject({ organizations: 2, repaired: 6, leftForAPerson: 4 });
  });
});
