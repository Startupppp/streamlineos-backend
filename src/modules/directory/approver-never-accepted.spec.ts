import { makeFakeDb } from "../../test/fake-select-db";
import type { Db } from "../../db/drizzle.types";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  users,
} from "../../db/schema";
import { ReportingLineService } from "./reporting-line.service";

/**
 * HRMS-E2E-015 / HRMS-E2E-011. `checkApprover` decided a manager could own
 * approvals from `users.is_active` — the ACCOUNT flag, set true the moment an
 * administrator creates the person, before the invitation has been sent, let
 * alone opened.
 *
 * So a manager who was invited and never signed in passed as eligible, and the
 * resolver named them as the approver for their reports' leave. The request then
 * sat with somebody who cannot open the product to decide it — indefinitely, and
 * with no indication to anyone why nothing was happening.
 *
 * This is the same acceptance test the headcount queries now use
 * (`hr/shared/employee-acceptance.ts`): `email_verified` non-null, which the
 * magic link sets the first time a person comes through it.
 *
 * Refusing here is safe by construction. `ApprovalAuthorityService.consider()`
 * records a skip reason and moves to the next rung, ending at the HR queue, and
 * `LeavesWriteService.create` only 409s when *every* rung fails. So the worst
 * case is a request routed to HR with a sentence saying why — never a request
 * that cannot be filed.
 */
const ORG = "org-1";
const MANAGER = "usr-manager";

function membership(overrides: Record<string, unknown> = {}) {
  return {
    org_id: ORG,
    user_id: MANAGER,
    status: "ACTIVE",
    is_owner: false,
    ...overrides,
  };
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: MANAGER,
    is_active: true,
    email_verified: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

function person() {
  return { id: 1, org_id: ORG, user_id: MANAGER, deleted_at: null };
}

function employment(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    org_id: ORG,
    person_id: 1,
    is_primary: true,
    lifecycle_status: "ACTIVE",
    deleted_at: null,
    ...overrides,
  };
}

function serviceWith(rows: Record<string, Record<string, unknown>[]>) {
  const db = makeFakeDb(rows, { organizationMembers, users, hrPeople, hrEmployments });
  return new ReportingLineService(db as unknown as Db);
}

describe("a manager who never accepted their invitation cannot own approvals", () => {
  it("accepts a manager who has signed in", async () => {
    // The paired positive. Without it, a rule that refused everybody would pass
    // the negative case below and quietly send every request to the HR queue.
    const service = serviceWith({
      organization_members: [membership()],
      users: [user()],
      hr_people: [person()],
      hr_employments: [employment()],
    });

    await expect(service.checkApprover(ORG, MANAGER)).resolves.toEqual({
      ok: true,
      managerEmploymentId: 10,
    });
  });

  it("refuses a manager whose invitation is still unopened", async () => {
    const service = serviceWith({
      organization_members: [membership()],
      users: [user({ email_verified: null })],
      hr_people: [person()],
      hr_employments: [employment()],
    });

    const result = await service.checkApprover(ORG, MANAGER);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("manager-never-accepted");
  });

  it("keeps refusing a deactivated account for its own reason", async () => {
    // The two states are different facts and an administrator fixes them
    // differently — one resends an invitation, the other reactivates a person.
    const service = serviceWith({
      organization_members: [membership()],
      users: [user({ is_active: false })],
      hr_people: [person()],
      hr_employments: [employment()],
    });

    const result = await service.checkApprover(ORG, MANAGER);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("manager-inactive");
  });

  it("refuses an unopened invitation even for the org owner", async () => {
    // The owner is exempted from the employment-record rule below, because a
    // founder is often not hired. Acceptance is a different question: an owner
    // who has never come through the magic link cannot approve anything either.
    const service = serviceWith({
      organization_members: [membership({ is_owner: true })],
      users: [user({ email_verified: null })],
      hr_people: [],
      hr_employments: [],
    });

    const result = await service.checkApprover(ORG, MANAGER);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("manager-never-accepted");
  });

  it("still accepts an owner who has signed in but was never hired", async () => {
    // The pairing for the case above, and the one the founder ICP depends on.
    const service = serviceWith({
      organization_members: [membership({ is_owner: true })],
      users: [user()],
      hr_people: [],
      hr_employments: [],
    });

    await expect(service.checkApprover(ORG, MANAGER)).resolves.toEqual({
      ok: true,
      managerEmploymentId: null,
    });
  });
});
