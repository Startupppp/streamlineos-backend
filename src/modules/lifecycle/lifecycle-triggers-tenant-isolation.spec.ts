import { NotFoundException } from "@nestjs/common";
import { deals } from "../../db/schema/crm/deals";
import { customerLifecycleTriggers, customerLifecycles } from "../../db/schema/crm/lifecycle";
import { tenantDb } from "../../test/tenant-recorder";
import type { DealsService } from "../deals/deals.service";
import type { OutboundService } from "../autonomy/outbound.service";
import { LifecycleTriggersService } from "./lifecycle-triggers.service";

/**
 * Cross-tenant isolation for renewal and churn triggers.
 *
 * A trigger opens a deal and hands it to the outbound loop, which can end in a
 * message to a customer. So the boundary here is not only "who can read the
 * trigger log": a sweep for one org must never pick up another org's customer
 * contract, open an opportunity for it, or ask the loop to write to it.
 *
 * The fixture holds the OWNER's due contract (the same one
 * `lifecycle-triggers.service.spec.ts` uses) and trigger row. The double
 * answers each statement by the equalities it bound, so without the org
 * predicate on the candidate read the owner's contract becomes the attacker's
 * candidate, and the deny cases see a deal opened and a message composed.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const AS_OF = new Date("2026-08-27T09:00:00.000Z");

const OWNER_CONTRACT = {
  organizationId: OWNER_ORG,
  customerLifecycleId: "lc_owner",
  partyId: "party_owner",
  status: "active",
  startedOn: "2025-09-30",
  renewalOn: "2026-09-30",
  riskScore: 10,
  lastSignalAt: null,
  expansionSignalAt: null,
  contractValueMinor: 1_234_567,
  healthScore: 71,
  healthStatus: "healthy",
  partyName: "Northwind Trading",
  companyName: "Northwind Trading Ltd",
  ownerUserId: "usr_owner_rep",
  triggerId: null,
  triggerKind: null,
  dueOn: null,
  opportunityDealId: null,
  attempts: null,
  lastAttemptAt: null,
  autonomyHoldId: null,
};

const OWNER_TRIGGER = {
  organizationId: OWNER_ORG,
  customerLifecycleTriggerId: "trg_owner",
  customerLifecycleId: "lc_owner",
  partyId: "party_owner",
  kind: "renewal-due",
  outcome: "held",
};

const HELD = {
  held: true as const,
  outboundMessageId: "msg_1",
  autonomyHoldId: "hold_1",
  decisionId: "dec_1",
  outboundClass: "follow_up" as const,
  holdUntil: new Date("2026-08-27T10:00:00.000Z"),
  windowSeconds: 3600,
};

function build() {
  const t = tenantDb({
    fixtures: [
      { table: customerLifecycles, org: customerLifecycles.organizationId, rows: [OWNER_CONTRACT] },
      { table: customerLifecycleTriggers, org: customerLifecycleTriggers.organizationId, rows: [OWNER_TRIGGER] },
    ],
  });
  const createDeal = jest.fn(async () => ({ id: 4242 }));
  const composeAndHold = jest.fn(async () => HELD);
  const service = new LifecycleTriggersService(
    t.db,
    { createDeal } as unknown as DealsService,
    { composeAndHold } as unknown as OutboundService,
  );
  return { t, createDeal, composeAndHold, service };
}

describe("LifecycleTriggersService — cross-tenant isolation", () => {
  it("deny: a sweep of one org never opens a deal or composes a message for another org's due contract", async () => {
    const { t, createDeal, composeAndHold, service } = build();

    const report = await service.sweep(ATTACKER_ORG, { limit: 50, asOf: AS_OF } as never);

    expect(report).toMatchObject({ considered: 0, opened: 0, held: 0 });
    expect(createDeal).not.toHaveBeenCalled();
    expect(composeAndHold).not.toHaveBeenCalled();
    expect(t.on(customerLifecycleTriggers, "insert")).toHaveLength(0);
    expect(t.orgBound(t.on(customerLifecycles, "select")[0], customerLifecycles.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: considering another org's customer lifecycle id is a 404 and acts on nothing", async () => {
    const { t, createDeal, composeAndHold, service } = build();

    await expect(service.consider(ATTACKER_ORG, "lc_owner", AS_OF)).rejects.toBeInstanceOf(NotFoundException);
    expect(createDeal).not.toHaveBeenCalled();
    expect(composeAndHold).not.toHaveBeenCalled();
    expect(t.orgBound(t.on(customerLifecycles, "select")[0], customerLifecycles.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: the trigger log shows the attacker none of another org's triggers", async () => {
    const { t, service } = build();

    const result = await service.list(ATTACKER_ORG, { limit: 50, offset: 0 } as never);

    expect(result.triggers).toEqual([]);
    expect(t.orgBound(t.on(customerLifecycleTriggers, "select")[0], customerLifecycleTriggers.organizationId)).toEqual([
      ATTACKER_ORG,
    ]);
  });

  it("control: the owning org's due contract opens its own opportunity and is offered to the loop as the owner", async () => {
    const { t, createDeal, composeAndHold, service } = build();

    const report = await service.sweep(OWNER_ORG, { limit: 50, asOf: AS_OF } as never);

    expect(report).toMatchObject({ considered: 1, opened: 1, held: 1 });
    expect(createDeal.mock.calls[0]).toEqual([OWNER_ORG, "usr_owner_rep", expect.anything()]);
    expect(composeAndHold).toHaveBeenCalledWith({ organizationId: OWNER_ORG, partyId: "party_owner", dealId: "4242" });
    expect(t.inserted(customerLifecycleTriggers).map((row) => row.organizationId)).toEqual([OWNER_ORG]);
    expect(t.orgBound(t.on(deals, "update")[0], deals.orgId)).toEqual([OWNER_ORG]);
    expect((await service.list(OWNER_ORG, { limit: 50, offset: 0 } as never)).triggers).toHaveLength(1);
  });
});
