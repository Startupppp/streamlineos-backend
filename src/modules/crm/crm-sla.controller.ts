import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CrmSlaService } from "./crm-sla.service";
import {
  slaPolicyCreateSchema,
  slaPolicyUpdateSchema,
  type SlaPolicyCreateInput,
  type SlaPolicyUpdateInput,
} from "./dto/sla.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("crm")
@Controller("crm/sla")
@UseGuards(JwtAuthGuard)
export class CrmSlaController {
  constructor(private readonly sla: CrmSlaService) {}

  @Get("policies")
  listPolicies(@CurrentUser() u: CurrentUserContext) {
    return this.sla.listPolicies(u.orgId);
  }

  @Post("policies")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:sla:manage")
  @HttpCode(201)
  createPolicy(
    @Body(new ZodValidationPipe(slaPolicyCreateSchema)) body: SlaPolicyCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sla.createPolicy(u.orgId, body);
  }

  @Patch("policies/:policyId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:sla:manage")
  async updatePolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(slaPolicyUpdateSchema)) body: SlaPolicyUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.sla.updatePolicy(u.orgId, policyId, body);
    if (!updated) throw new NotFoundException("Policy not found");
    return updated;
  }

  @Delete("policies/:policyId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:sla:manage")
  deletePolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sla.deletePolicy(u.orgId, policyId);
  }

  @Get("breached")
  breached(@CurrentUser() u: CurrentUserContext) {
    return this.sla.breached(u.orgId);
  }

  @Get("report")
  report(@CurrentUser() u: CurrentUserContext) {
    return this.sla.report(u.orgId);
  }
}
