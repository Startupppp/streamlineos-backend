import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CareerService } from "./career.service";
import type { careerPaths, employeeCareerPlans } from "../../db/schema";

@RequireModule("hr")
@Controller("hr/career-development")
@UseGuards(JwtAuthGuard)
export class CareerController {
  constructor(private readonly careerService: CareerService) {}

  @Get("my-plan")
  getMyPlan(@CurrentUser() u: CurrentUserContext) {
    return this.careerService.getMyPlan(u.orgId, u.userId);
  }

  @Put("my-plan")
  saveMyPlan(@CurrentUser() u: CurrentUserContext, @Body() body: Record<string, unknown>) {
    return this.careerService.saveMyPlan(u.orgId, u.userId, body as Partial<typeof employeeCareerPlans.$inferInsert>);
  }

  @Patch("my-plan/milestones/:milestoneIdx")
  updateMilestone(
    @CurrentUser() u: CurrentUserContext,
    @Param("milestoneIdx", ParseIntPipe) idx: number,
    @Body("completed") completed: boolean,
  ) {
    return this.careerService.updateMilestone(u.orgId, u.userId, idx, completed);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:learning:view")
  listPaths(@CurrentUser() u: CurrentUserContext) {
    return this.careerService.listPaths(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:learning:manage")
  createPath(@CurrentUser() u: CurrentUserContext, @Body() body: Record<string, unknown>) {
    return this.careerService.createPath(u.orgId, body as typeof careerPaths.$inferInsert);
  }

  @Patch(":pathId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:learning:manage")
  updatePath(
    @CurrentUser() u: CurrentUserContext,
    @Param("pathId", ParseIntPipe) pathId: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.careerService.updatePath(u.orgId, pathId, body as Partial<typeof careerPaths.$inferInsert>);
  }
}
