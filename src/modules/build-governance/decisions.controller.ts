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
import { DecisionsService } from "./decisions.service";
import {
  createDecisionSchema,
  listDecisionsQuerySchema,
  updateDecisionSchema,
  type CreateDecisionInput,
  type ListDecisionsQuery,
  type UpdateDecisionInput,
} from "./dto/governance.schemas";

@RequireModule("build")
@Controller("build/:projectId/decisions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DecisionsController {
  constructor(private readonly svc: DecisionsService) {}

  @Get()
  @RequirePermission("build:decisions:view")
  listDecisions(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(listDecisionsQuerySchema)) query: ListDecisionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listDecisions(u.orgId, projectId, query);
  }

  @Get(":decisionId")
  @RequirePermission("build:decisions:view")
  getDecision(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("decisionId", ParseIntPipe) decisionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getDecision(u.orgId, projectId, decisionId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:decisions:manage")
  createDecision(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createDecisionSchema)) body: CreateDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createDecision(u.orgId, u.userId, projectId, body);
  }

  @Patch(":decisionId")
  @RequirePermission("build:decisions:manage")
  updateDecision(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("decisionId", ParseIntPipe) decisionId: number,
    @Body(new ZodValidationPipe(updateDecisionSchema)) body: UpdateDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateDecision(u.orgId, u.userId, projectId, decisionId, body);
  }

  @Delete(":decisionId")
  @RequirePermission("build:decisions:manage")
  @HttpCode(204)
  softDeleteDecision(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("decisionId", ParseIntPipe) decisionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteDecision(u.orgId, u.userId, projectId, decisionId);
  }
}
