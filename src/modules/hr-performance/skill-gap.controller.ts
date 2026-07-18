import { Controller, Get, Post, Delete, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { SkillGapService } from "./skill-gap.service";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { addSkillRequirementSchema, type AddSkillRequirementInput } from "./dto/skill-gap.schemas";

@RequireModule("hr")
@Controller("hr/skills")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SkillGapController {
  constructor(private readonly skillGapService: SkillGapService) {}

  @Get("gaps")
  @RequirePermission("hr:performance:view")
  getGaps(
    @CurrentUser() user: CurrentUserContext,
    @Query("employeeId") employeeId?: string,
    @Query("departmentId") departmentIdStr?: string,
  ) {
    return this.skillGapService.getGaps(user.orgId, {
      employeeId,
      departmentId: departmentIdStr ? parseInt(departmentIdStr, 10) : undefined,
    });
  }

  @Get("requirements")
  @RequirePermission("hr:performance:view")
  listRequirements(@CurrentUser() user: CurrentUserContext) {
    return this.skillGapService.listRequirements(user.orgId);
  }

  @Post("requirements")
  @RequirePermission("hr:performance:manage")
  addRequirement(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(addSkillRequirementSchema)) body: AddSkillRequirementInput,
  ) {
    return this.skillGapService.addRequirement(user.orgId, body);
  }

  @Delete("requirements/:id")
  @RequirePermission("hr:performance:manage")
  removeRequirement(@CurrentUser() user: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.skillGapService.removeRequirement(user.orgId, id);
  }
}
