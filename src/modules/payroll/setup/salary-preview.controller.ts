import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { SalaryPreviewService } from "./salary-preview.service";
import { salaryPreviewSchema, type SalaryPreviewInput } from "./dto/setup.schemas";
import { salaryPreviewResponseSchema } from "./dto/setup-response.schemas";

@RequireModule("payroll")
@Controller("payroll/salary-preview")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SalaryPreviewController {
  constructor(private readonly service: SalaryPreviewService) {}

  @Post()
  @HttpCode(200)
  @RequirePermission("payroll:salaries:view")
  @Validate({ body: salaryPreviewSchema })
  @ResponseSchema(salaryPreviewResponseSchema)
  async preview(
    @Body() body: SalaryPreviewInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.preview(u.orgId, body);
  }
}
