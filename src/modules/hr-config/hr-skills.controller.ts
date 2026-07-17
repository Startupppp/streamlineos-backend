import { Body, Controller, Get, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrCompetenciesService } from "./hr-competencies.service";
import {
  createSkillSchema,
  skillListQuerySchema,
  type CreateSkillInput,
  type SkillListQuery,
} from "./dto/competencies.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/skills")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrSkillsController {
  constructor(private readonly competencies: HrCompetenciesService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  list(
    @Query(new ZodValidationPipe(skillListQuerySchema)) query: SkillListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.competencies.listSkills(u.orgId, query);
  }

  @Post()
  @RequirePermission("hr:employees:manage")
  async create(
    @Body(new ZodValidationPipe(createSkillSchema)) body: CreateSkillInput,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const targetUserId = body.userId ?? u.userId;
    const result = await this.competencies.createSkill(u.orgId, targetUserId, body);
    res.status(result.created ? 201 : 200);
    return result.data;
  }
}
