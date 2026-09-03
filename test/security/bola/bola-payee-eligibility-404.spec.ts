import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PayeeEligibilityController } from "src/modules/payroll/runs/payee-eligibility.controller";
import type {
  PayeeEligibility,
  PayeeEligibilityService,
} from "src/modules/payroll/runs/payee-eligibility.service";
import type { CurrentUserContext } from "src/common/auth/backend-claims";

/**
 * `GET /payroll/people/:organizationPersonId/eligibility` — found by the live cross-tenant sweep.
 *
 * `resolvePerson` re-asserts `orgId` on every query, so another organization's person resolves
 * `unresolved` — the seam does its job. The route then returned that as a **200** carrying
 * `reason: "unknown-person"`, which is precisely what backend/CLAUDE.md §1 forbids: an unresolved
 * subject is surfaced as 404, never 403 and never a soft 200. The sweep measured control 200,
 * cross-tenant 200 and absent-id 200, so nothing was disclosed and the contract 404 was absent.
 *
 * The service keeps `unknown-person` — it is the honest domain answer and `payee-eligibility.service.spec.ts`
 * pins it — and the boundary maps it to the status the contract requires.
 */

const CALLER: CurrentUserContext = {
  userId: "user-b",
  orgId: "org-b-caller",
  sessionId: "s",
} as CurrentUserContext;

const FOREIGN_PERSON = "person-in-org-a";

function controllerAnswering(reason: PayeeEligibility["reason"]): {
  controller: PayeeEligibilityController;
  asked: string[];
} {
  const asked: string[] = [];
  const service = {
    getEligibility: jest.fn().mockImplementation((orgId: string, personId: string) => {
      asked.push(`${orgId}|${personId}`);
      return Promise.resolve({
        organizationPersonId: personId,
        payable: reason === "payable",
        payableAs: null,
        payeeUserId: null,
        payeeWorkerId: null,
        resolvedVia: reason === "unknown-person" ? null : "person-record",
        employment: null,
        reason,
      } satisfies PayeeEligibility);
    }),
  } as unknown as PayeeEligibilityService;
  return { controller: new PayeeEligibilityController(service), asked };
}

describe("BOLA probe — GET /payroll/people/:organizationPersonId/eligibility", () => {
  it("CROSS-TENANT-MISS: another organization's person id is refused", async () => {
    const { controller } = controllerAnswering("unknown-person");
    await expect(controller.getEligibility(FOREIGN_PERSON, CALLER)).rejects.toThrow(NotFoundException);
  });

  it("EXISTENCE-ORACLE-GUARD: the refusal is NotFound, never Forbidden", async () => {
    const { controller } = controllerAnswering("unknown-person");
    const thrown = await controller
      .getEligibility(FOREIGN_PERSON, CALLER)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("NO-BODY-ON-MISS: the refusal carries no eligibility payload to read", async () => {
    const { controller } = controllerAnswering("unknown-person");
    const thrown = (await controller
      .getEligibility(FOREIGN_PERSON, CALLER)
      .catch((error: unknown) => error)) as NotFoundException;
    expect(JSON.stringify(thrown.getResponse())).not.toContain("unknown-person");
  });

  it("SUBJECT-SCOPE: the person is resolved under the CALLER's org, never the path's", async () => {
    const { controller, asked } = controllerAnswering("unknown-person");
    await controller.getEligibility(FOREIGN_PERSON, CALLER).catch(() => undefined);
    expect(asked).toEqual([`${CALLER.orgId}|${FOREIGN_PERSON}`]);
  });

  it("SAME-TENANT: a person the caller's org DOES hold still answers, so this is not a blanket denial", async () => {
    for (const reason of ["payable", "not-payable", "employed-but-not-payable"] as const) {
      const { controller } = controllerAnswering(reason);
      await expect(controller.getEligibility("person-in-org-b", CALLER)).resolves.toMatchObject({ reason });
    }
  });
});
