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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  IntakeService,
  MilestonesService,
  ViewsService,
} from "./workspace.service";
import { WhiteboardsService } from "./whiteboards.service";
import {
  createIntakeSchema,
  createMilestoneSchema,
  createViewSchema,
  createWhiteboardSchema,
  intakeListQuerySchema,
  updateIntakeSchema,
  updateMilestoneSchema,
  updateViewSchema,
  updateWhiteboardSchema,
  type CreateIntakeInput,
  type CreateMilestoneInput,
  type CreateViewInput,
  type CreateWhiteboardInput,
  type IntakeListQuery,
  type UpdateIntakeInput,
  type UpdateMilestoneInput,
  type UpdateViewInput,
  type UpdateWhiteboardInput,
} from "./dto/workspace.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("build")
@Controller("build/:projectId/milestones")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MilestonesController {
  constructor(private readonly milestones: MilestonesService) {}

  @Get()
  @RequirePermission("build:view")
  listMilestones(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.listMilestones(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  createMilestone(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createMilestoneSchema)) body: CreateMilestoneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.createMilestone(u.orgId, u.userId, projectId, body);
  }

  @Patch(":milestoneId")
  @RequirePermission("build:workspace:manage")
  updateMilestone(
    @Param("milestoneId", ParseIntPipe) milestoneId: number,
    @Body(new ZodValidationPipe(updateMilestoneSchema)) body: UpdateMilestoneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.updateMilestone(u.orgId, milestoneId, body);
  }

  @Delete(":milestoneId")
  @RequirePermission("build:workspace:manage")
  @HttpCode(204)
  deleteMilestone(
    @Param("milestoneId", ParseIntPipe) milestoneId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.deleteMilestone(u.orgId, milestoneId);
  }
}

@RequireModule("build")
@Controller("build/:projectId/intake")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Get()
  @RequirePermission("build:view")
  listIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(intakeListQuerySchema)) query: IntakeListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.intake.listIntake(u.orgId, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  createIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createIntakeSchema)) body: CreateIntakeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.intake.createIntake(u.orgId, projectId, body);
  }

  @Patch(":requestId")
  @RequirePermission("build:workspace:manage")
  updateIntake(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(updateIntakeSchema)) body: UpdateIntakeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.intake.updateIntake(u.orgId, u.userId, requestId, body);
  }
}

@RequireModule("build")
@Controller("build/:projectId/views")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  @RequirePermission("build:view")
  listViews(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.listViews(u.orgId, u.userId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  createView(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createViewSchema)) body: CreateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.createView(u.orgId, u.userId, projectId, body);
  }

  @Patch(":viewId")
  @RequirePermission("build:workspace:manage")
  updateView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @Body(new ZodValidationPipe(updateViewSchema)) body: UpdateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.updateView(u.orgId, u.userId, viewId, body);
  }

  @Delete(":viewId")
  @RequirePermission("build:workspace:manage")
  @HttpCode(204)
  deleteView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.deleteView(u.orgId, u.userId, viewId);
  }
}

@RequireModule("build")
@Controller("build/views")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WorkspaceViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  @RequirePermission("build:view")
  listWorkspaceViews(@CurrentUser() u: CurrentUserContext) {
    return this.views.listWorkspaceViews(u.orgId, u.userId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  createWorkspaceView(
    @Body(new ZodValidationPipe(createViewSchema)) body: CreateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.createWorkspaceView(u.orgId, u.userId, body);
  }

  @Patch(":viewId")
  @RequirePermission("build:workspace:manage")
  updateWorkspaceView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @Body(new ZodValidationPipe(updateViewSchema)) body: UpdateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.updateWorkspaceView(u.orgId, u.userId, viewId, body);
  }

  @Delete(":viewId")
  @RequirePermission("build:workspace:manage")
  @HttpCode(204)
  deleteWorkspaceView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.deleteWorkspaceView(u.orgId, u.userId, viewId);
  }
}

@RequireModule("build")
@Controller("whiteboards")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WhiteboardsHubController {
  constructor(private readonly whiteboards: WhiteboardsService) {}

  @Get()
  @RequirePermission("build:view")
  listAllWhiteboards(@CurrentUser() u: CurrentUserContext) {
    return this.whiteboards.listAllWhiteboards(u);
  }
}

@RequireModule("build")
@Controller("build/:projectId/whiteboards")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WhiteboardsController {
  constructor(private readonly whiteboards: WhiteboardsService) {}

  @Get()
  @RequirePermission("build:view")
  listWhiteboards(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.listWhiteboards(u, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:whiteboards:manage")
  createWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createWhiteboardSchema)) body: CreateWhiteboardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.createWhiteboard(u, projectId, body);
  }

  @Get(":whiteboardId")
  @RequirePermission("build:view")
  getWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.getWhiteboard(u, projectId, whiteboardId);
  }

  @Patch(":whiteboardId")
  @RequirePermission("build:whiteboards:manage")
  updateWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @Body(new ZodValidationPipe(updateWhiteboardSchema)) body: UpdateWhiteboardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.updateWhiteboard(u, projectId, whiteboardId, body);
  }

  @Delete(":whiteboardId")
  @RequirePermission("build:whiteboards:manage")
  @HttpCode(204)
  deleteWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.deleteWhiteboard(u, projectId, whiteboardId);
  }
}

