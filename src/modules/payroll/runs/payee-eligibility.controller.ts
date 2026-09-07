import { Controller, Get, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayeeEligibilityService } from "./payee-eligibility.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { payeeEligibilityResponseSchema } from "./dto/payee-eligibility-response.schemas";
import { z } from "zod";

const organizationPersonIdParams = z.object({ organizationPersonId: z.string().min(1) }).strict();

@RequireModule("payroll")
@Controller("payroll/people")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayeeEligibilityController {
  constructor(private readonly eligibility: PayeeEligibilityService) {}

  @Get(":organizationPersonId/eligibility")
  @RequirePermission("payroll:salaries:view")
  @ResponseSchema(payeeEligibilityResponseSchema)
  @Validate({ params: organizationPersonIdParams })
  async getEligibility(
    @Param("organizationPersonId") organizationPersonId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const eligibility = await this.eligibility.getEligibility(u.orgId, organizationPersonId);
    /**
     * `resolvePerson` re-asserts `orgId` on every query, so another organization's person — and a
     * person id belonging to nobody — both come back unresolved. Returning that as a 200 body is
     * the answer the seam's own rule forbids: backend/CLAUDE.md §1 says an unresolved subject is
     * surfaced as 404, never 403. Measured by the live cross-tenant sweep, this route answered 200
     * to a borrowed `organizationPersonId` and 200 to an absent one, so nothing was disclosed and
     * the required 404 was simply missing. `unknown-person` stays a value of the service's union —
     * it is the honest domain answer and its own spec pins it — and the boundary turns it into the
     * status the contract requires.
     */
    if (eligibility.reason === "unknown-person") throw new NotFoundException("Person not found");
    return eligibility;
  }
}
