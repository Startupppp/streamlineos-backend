jest.mock("../../../common/tenant", () => ({
  ...jest.requireActual("../../../common/tenant"),
  forEachOrg: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import { forEachOrg } from "../../../common/tenant";
import {
  businessParties,
  crmNurtureEnrollments,
  crmNurtureSequenceSteps,
  crmNurtureSequences,
  deals,
} from "../../../db/schema";
import { tenantDb } from "../../../test/tenant-recorder";
import { NurtureSequencesService } from "./nurture-sequences.service";
import { NurtureStepSenderService } from "./nurture-step-sender.service";

/**
 * Cross-tenant isolation for nurture sequences: the sequences an org builds,
 * who it enrols in them, and the sweep that sends each due step through the
 * outbound loop.
 *
 * The sender is the one with teeth — a due step ends in `composeAndHold`, which
 * drafts a message to a customer. So beyond "another org's sequence is a 404",
 * the deny cases prove the attacker cannot enrol another org's customer or deal
 * in its own sequence, and that one org's sweep never composes for another
 * org's enrolment. The double answers each statement by the equalities it
 * bound, so a missing org predicate hands the owner's row to the attacker.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const SIXTY_DAYS_AGO = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

const sequence = (orgId: string, id: string) => ({
  organizationId: orgId,
  nurtureSequenceId: id,
  name: `${orgId} win-back`,
  description: null,
  status: "active",
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  deletedAt: null,
});
const step = (orgId: string, sequenceId: string) => ({
  organizationId: orgId,
  nurtureSequenceId: sequenceId,
  nurtureStepId: `step-${sequenceId}`,
  stepNumber: 1,
  waitHours: 24,
  steps: 1,
});
const OWNER_ENROLMENT = {
  organizationId: OWNER_ORG,
  nurtureEnrollmentId: "enr-owner",
  nurtureSequenceId: "seq-owner",
  partyId: "party-owner",
  dealId: null,
  status: "active",
  currentStep: 0,
  exitReason: null,
  exitedAt: null,
  enrolledAt: SIXTY_DAYS_AGO,
  updatedAt: SIXTY_DAYS_AGO,
  sequenceStatus: "active",
  sequenceDeletedAt: null,
};

function store() {
  return tenantDb({
    fixtures: [
      {
        table: crmNurtureSequences,
        org: crmNurtureSequences.organizationId,
        rows: [sequence(OWNER_ORG, "seq-owner"), sequence(ATTACKER_ORG, "seq-attacker")],
      },
      {
        table: crmNurtureSequenceSteps,
        org: crmNurtureSequenceSteps.organizationId,
        rows: [step(OWNER_ORG, "seq-owner"), step(ATTACKER_ORG, "seq-attacker")],
      },
      {
        table: businessParties,
        org: businessParties.organizationId,
        rows: [
          { organizationId: OWNER_ORG, partyId: "party-owner", name: "Owner customer", deletedAt: null },
          { organizationId: ATTACKER_ORG, partyId: "party-attacker", name: "Attacker customer", deletedAt: null },
        ],
      },
      { table: deals, org: deals.orgId, rows: [{ orgId: OWNER_ORG, id: 42, name: "Owner deal", deletedAt: null }] },
      { table: crmNurtureEnrollments, org: crmNurtureEnrollments.organizationId, rows: [OWNER_ENROLMENT] },
    ],
  });
}

describe("NurtureSequencesService — cross-tenant isolation", () => {
  it("deny: another org's sequence id is a 404 and none of its steps or enrolments are read", async () => {
    const t = store();
    const service = new NurtureSequencesService(t.db);

    await expect(service.getOne(ATTACKER_ORG, "seq-owner")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.listEnrollments(ATTACKER_ORG, "seq-owner", { limit: 20 } as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(ATTACKER_ORG, "seq-owner")).rejects.toBeInstanceOf(NotFoundException);
    for (const read of t.on(crmNurtureSequences, "select"))
      expect(t.orgBound(read, crmNurtureSequences.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.on(crmNurtureSequenceSteps)).toHaveLength(0);
    expect(t.on(crmNurtureEnrollments)).toHaveLength(0);
    expect(t.on(crmNurtureSequences, "update")).toHaveLength(0);
  });

  it("deny: the sequence list shows the attacker none of another org's sequences", async () => {
    const t = store();
    const page = await new NurtureSequencesService(t.db).list(ATTACKER_ORG, { limit: 20 } as never);

    expect(JSON.stringify(page)).not.toContain("seq-owner");
    expect(t.orgBound(t.on(crmNurtureSequences, "select")[0], crmNurtureSequences.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: the attacker cannot enrol another org's customer, or tie in another org's deal, in its own sequence", async () => {
    const t = store();
    const service = new NurtureSequencesService(t.db);

    await expect(
      service.enrol(ATTACKER_ORG, "seq-attacker", "usr-attacker", { partyId: "party-owner" } as never),
    ).rejects.toThrow("Customer not found");
    await expect(
      service.enrol(ATTACKER_ORG, "seq-attacker", "usr-attacker", { partyId: "party-attacker", dealId: "42" } as never),
    ).rejects.toThrow("Deal not found");
    expect(t.on(crmNurtureEnrollments, "insert")).toHaveLength(0);
    for (const read of t.on(businessParties, "select"))
      expect(t.orgBound(read, businessParties.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(t.on(deals, "select")[0], deals.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: another org's enrolment cannot be stopped", async () => {
    const t = store();

    await expect(new NurtureSequencesService(t.db).unenrol(ATTACKER_ORG, "seq-owner", "enr-owner")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(t.orgBound(t.on(crmNurtureEnrollments, "update")[0], crmNurtureEnrollments.organizationId)).toEqual([
      ATTACKER_ORG,
    ]);
  });

  it("control: the owning org reads its sequence and enrols its own customer", async () => {
    const t = store();
    const service = new NurtureSequencesService(t.db);

    const one = await service.getOne(OWNER_ORG, "seq-owner");
    expect(one.sequence.nurtureSequenceId).toBe("seq-owner");
    expect(one.steps).toHaveLength(1);
    const enrolled = await service.enrol(OWNER_ORG, "seq-owner", "usr-owner", { partyId: "party-owner" } as never);
    expect(enrolled).toMatchObject({ partyId: "party-owner", partyName: "Owner customer" });
    expect(t.inserted(crmNurtureEnrollments).map((row) => row.organizationId)).toEqual([OWNER_ORG]);
  });
});

describe("NurtureStepSenderService — cross-tenant isolation", () => {
  const HELD = { held: true, outboundMessageId: "msg-1", autonomyHoldId: "hold-1" };

  function build() {
    const t = store();
    const composeAndHold = jest.fn(async () => HELD);
    const service = new NurtureStepSenderService(t.db, { composeAndHold } as never);
    return { t, composeAndHold, service };
  }

  it("deny: one org's run never composes a step for another org's enrolment", async () => {
    const { t, composeAndHold, service } = build();

    const outcome = await service.runDueStepsForOrg(ATTACKER_ORG);

    expect(outcome.considered).toBe(0);
    expect(composeAndHold).not.toHaveBeenCalled();
    expect(t.on(crmNurtureEnrollments, "update")).toHaveLength(0);
    const [candidates] = t.on(crmNurtureEnrollments, "select");
    expect(t.orgBound(candidates, crmNurtureEnrollments.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound({ ...candidates!, where: candidates!.joins }, crmNurtureSequences.organizationId)).toEqual([
      ATTACKER_ORG,
    ]);
  });

  it("deny: the sweep composes each org's due steps as that org only", async () => {
    const { t, composeAndHold, service } = build();
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _sweep: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
        for (const orgId of [ATTACKER_ORG, OWNER_ORG]) await fn(t.db, orgId);
        return { succeeded: 2, failed: 0 };
      },
    );

    const result = await service.sweepDueSteps();

    expect(result).toMatchObject({ considered: 1, held: 1 });
    expect(composeAndHold.mock.calls).toEqual([[{ organizationId: OWNER_ORG, partyId: "party-owner", dealId: null }]]);
  });

  it("control: the owning org's due step is composed for its own customer", async () => {
    const { t, composeAndHold, service } = build();

    const outcome = await service.runDueStepsForOrg(OWNER_ORG);

    expect(outcome).toMatchObject({ considered: 1, held: 1 });
    expect(composeAndHold).toHaveBeenCalledWith({ organizationId: OWNER_ORG, partyId: "party-owner", dealId: null });
    expect(t.orgBound(t.on(crmNurtureEnrollments, "update")[0], crmNurtureEnrollments.organizationId)).toEqual([OWNER_ORG]);
  });
});
