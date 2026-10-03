import { Controller, Delete, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { PayrollSampleDataService } from "./sample-data.service";
import { sampleDataStatusSchema } from "./dto/sample-data.schemas";

@RequireModule("payroll")
@Controller("payroll/sample-data")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollSampleDataController {
  constructor(private readonly sampleData: PayrollSampleDataService) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  @ResponseSchema(sampleDataStatusSchema)
  status(@CurrentUser() u: CurrentUserContext) {
    return this.sampleData.status(u.orgId);
  }

  @Post()
  @HttpCode(200)
  @RequirePermission("payroll:settings:manage")
  @Idempotent("payroll.sample_data.seed")
  @ResponseSchema(sampleDataStatusSchema)
  seed(@CurrentUser() u: CurrentUserContext) {
    return this.sampleData.seed(u.orgId, { userId: u.userId, membershipId: actingMembershipId(u.principal) });
  }

  @Delete()
  @RequirePermission("payroll:settings:manage")
  @Idempotent("payroll.sample_data.remove")
  @ResponseSchema(sampleDataStatusSchema)
  remove(@CurrentUser() u: CurrentUserContext) {
    return this.sampleData.remove(u.orgId, { userId: u.userId, membershipId: actingMembershipId(u.principal) });
  }
}
