/**
 * HRMS-E2E-015, approver half.
 *
 * Unlike a headcount, where counting an unaccepted invitee is a reporting
 * error, putting one in an approver pool is an availability error: the person
 * has never followed their magic link, so they cannot sign in, cannot open the
 * inbox and cannot decide. A step routed to a pool of one such person waits
 * until it escalates.
 *
 * The role pools resolve through `AccessService.membersWithPermission`, which
 * answers on grants alone and knows nothing about acceptance, so the filter has
 * to be applied here.
 */

import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import { makeFakeDb, type TableRows } from "../../../test/fake-select-db";
import { HrWorkflowApproverService } from "./hr-workflow-approver.service";
import type { ResolvedStep } from "./hr-workflow-engine.types";

const ORG = "org-1";

function orgRows(): TableRows {
  return {
    organization_members: [
      { id: 1, org_id: ORG, user_id: "u-accepted", role: "ADMIN", status: "ACTIVE" },
      { id: 2, org_id: ORG, user_id: "u-pending", role: "ADMIN", status: "ACTIVE" },
    ],
    users: [
      { id: "u-accepted", is_active: true, email_verified: new Date("2026-01-02T00:00:00.000Z") },
      { id: "u-pending", is_active: true, email_verified: null },
    ],
  };
}

function accessDouble(): AccessService {
  const double = {
    membersWithPermission: () =>
      Promise.resolve([{ userId: "u-accepted" }, { userId: "u-pending" }]),
  };
  return double as unknown as AccessService;
}

function step(approverType: string): ResolvedStep {
  const resolved = { approverType, approverValue: null };
  return resolved as unknown as ResolvedStep;
}

function service(): HrWorkflowApproverService {
  return new HrWorkflowApproverService(
    makeFakeDb(orgRows()) as unknown as Db,
    accessDouble(),
    undefined as never,
    undefined as never,
  );
}

describe("workflow approver pools exclude someone who never accepted their invitation", () => {
  it("drops the pending member from an hr_role pool but keeps the accepted one", async () => {
    const approvers = await service().resolveApprovers(step("hr_role"), "u-subject", ORG, "leave_request");

    expect(approvers).toEqual(["u-accepted"]);
  });

  it("drops the pending member from a finance_role pool but keeps the accepted one", async () => {
    const approvers = await service().resolveApprovers(
      step("finance_role"),
      "u-subject",
      ORG,
      "leave_request",
    );

    expect(approvers).toEqual(["u-accepted"]);
  });
});
