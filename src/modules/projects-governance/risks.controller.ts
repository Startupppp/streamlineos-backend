import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RisksService } from "./risks.service";
import {
  createRiskSchema,
  listRisksQuerySchema,
  updateRiskSchema,
  type CreateRiskInput,
  type ListRisksQuery,
  type UpdateRiskInput,
} from "./dto/governance.schemas";

@RequireModule("projects")
@Controller("projects/:projectId/risks")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RisksController {
  constructor(private readonly svc: RisksService) {}

  @Get()
  @RequirePermission("projects:risks:view")
  listRisks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(listRisksQuerySchema)) query: ListRisksQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRisks(u.orgId, projectId, query);
  }

  @Get(":riskId")
  @RequirePermission("projects:risks:view")
  getRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("riskId", ParseIntPipe) riskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getRisk(u.orgId, projectId, riskId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:risks:manage")
  createRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createRiskSchema)) body: CreateRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createRisk(u.orgId, u.userId, projectId, body);
  }

  @Patch(":riskId")
  @RequirePermission("projects:risks:manage")
  updateRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("riskId", ParseIntPipe) riskId: number,
    @Body(new ZodValidationPipe(updateRiskSchema)) body: UpdateRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateRisk(u.orgId, u.userId, projectId, riskId, body);
  }

  @Delete(":riskId")
  @RequirePermission("projects:risks:manage")
  softDeleteRisk(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("riskId", ParseIntPipe) riskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteRisk(u.orgId, u.userId, projectId, riskId);
  }
}
