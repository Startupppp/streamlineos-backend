import { Controller, Delete, Get, HttpCode, NotFoundException, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { AccessService } from "../../access/access.service";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { PayrollSampleDataService } from "./sample-data.service";
import { sampleDataStatusSchema } from "./dto/sample-data.schemas";
import { resolvePayrollRunsViewScope } from "../payroll-scope";

@RequireModule("payroll")
@Controller("payroll/sample-data")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollSampleDataController {
  constructor(
    private readonly sampleData: PayrollSampleDataService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  @ResponseSchema(sampleDataStatusSchema)
  async status(@CurrentUser() u: CurrentUserContext) {
    const read = await resolvePayrollRunsViewScope(this.access, u);
    if (!read.unrestricted) throw new NotFoundException("Payroll sample data not found");
    return this.sampleData.status(u.orgId);
  }

  @Post()
  @BodylessAction()
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
