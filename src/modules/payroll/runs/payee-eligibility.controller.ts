import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayeeEligibilityService } from "./payee-eligibility.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const organizationPersonIdParams = z.object({ organizationPersonId: z.string().min(1) }).strict();

@RequireModule("payroll")
@Controller("payroll/people")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayeeEligibilityController {
  constructor(private readonly eligibility: PayeeEligibilityService) {}

  @Get(":organizationPersonId/eligibility")
  @RequirePermission("payroll:salaries:view")
  @Validate({ params: organizationPersonIdParams })
  async getEligibility(
    @Param("organizationPersonId") organizationPersonId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.eligibility.getEligibility(u.orgId, organizationPersonId);
  }
}
