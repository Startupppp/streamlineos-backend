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
  PagesService,
  ViewsService,
} from "./workspace.service";
import { WhiteboardsService } from "./whiteboards.service";
import {
  createIntakeSchema,
  createMilestoneSchema,
  createPageSchema,
  createViewSchema,
  createWhiteboardSchema,
  intakeListQuerySchema,
  updateIntakeSchema,
  updateMilestoneSchema,
  updatePageSchema,
  updateViewSchema,
  updateWhiteboardSchema,
  type CreateIntakeInput,
  type CreateMilestoneInput,
  type CreatePageInput,
  type CreateViewInput,
  type CreateWhiteboardInput,
  type IntakeListQuery,
  type UpdateIntakeInput,
  type UpdateMilestoneInput,
  type UpdatePageInput,
  type UpdateViewInput,
  type UpdateWhiteboardInput,
} from "./dto/workspace.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("projects")
@Controller("projects/:projectId/milestones")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MilestonesController {
  constructor(private readonly milestones: MilestonesService) {}

  @Get()
  @RequirePermission("projects:view")
  listMilestones(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.listMilestones(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:workspace:manage")
  createMilestone(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createMilestoneSchema)) body: CreateMilestoneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.createMilestone(u.orgId, u.userId, projectId, body);
  }

  @Patch(":milestoneId")
  @RequirePermission("projects:workspace:manage")
  updateMilestone(
    @Param("milestoneId", ParseIntPipe) milestoneId: number,
    @Body(new ZodValidationPipe(updateMilestoneSchema)) body: UpdateMilestoneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.updateMilestone(u.orgId, milestoneId, body);
  }

  @Delete(":milestoneId")
  @RequirePermission("projects:workspace:manage")
  deleteMilestone(
    @Param("milestoneId", ParseIntPipe) milestoneId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.deleteMilestone(u.orgId, milestoneId);
  }
}

@RequireModule("projects")
@Controller("projects/:projectId/intake")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Get()
  @RequirePermission("projects:view")
  listIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(intakeListQuerySchema)) query: IntakeListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.intake.listIntake(u.orgId, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:workspace:manage")
  createIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createIntakeSchema)) body: CreateIntakeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.intake.createIntake(u.orgId, projectId, body);
  }

  @Patch(":requestId")
  @RequirePermission("projects:workspace:manage")
  updateIntake(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(updateIntakeSchema)) body: UpdateIntakeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.intake.updateIntake(u.orgId, u.userId, requestId, body);
  }
}

@RequireModule("projects")
@Controller("projects/:projectId/views")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  @RequirePermission("projects:view")
  listViews(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.listViews(u.orgId, u.userId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:workspace:manage")
  createView(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createViewSchema)) body: CreateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.createView(u.orgId, u.userId, projectId, body);
  }

  @Patch(":viewId")
  @RequirePermission("projects:workspace:manage")
  updateView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @Body(new ZodValidationPipe(updateViewSchema)) body: UpdateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.updateView(u.orgId, u.userId, viewId, body);
  }

  @Delete(":viewId")
  @RequirePermission("projects:workspace:manage")
  deleteView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.deleteView(u.orgId, u.userId, viewId);
  }
}

@RequireModule("projects")
@Controller("projects/views")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WorkspaceViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  @RequirePermission("projects:view")
  listWorkspaceViews(@CurrentUser() u: CurrentUserContext) {
    return this.views.listWorkspaceViews(u.orgId, u.userId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:workspace:manage")
  createWorkspaceView(
    @Body(new ZodValidationPipe(createViewSchema)) body: CreateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.createWorkspaceView(u.orgId, u.userId, body);
  }

  @Patch(":viewId")
  @RequirePermission("projects:workspace:manage")
  updateWorkspaceView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @Body(new ZodValidationPipe(updateViewSchema)) body: UpdateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.updateWorkspaceView(u.orgId, u.userId, viewId, body);
  }

  @Delete(":viewId")
  @RequirePermission("projects:workspace:manage")
  deleteWorkspaceView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.deleteWorkspaceView(u.orgId, u.userId, viewId);
  }
}

@RequireModule("projects")
@Controller("whiteboards")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WhiteboardsHubController {
  constructor(private readonly whiteboards: WhiteboardsService) {}

  @Get()
  @RequirePermission("projects:view")
  listAllWhiteboards(@CurrentUser() u: CurrentUserContext) {
    return this.whiteboards.listAllWhiteboards(u);
  }
}

@RequireModule("projects")
@Controller("projects/:projectId/whiteboards")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WhiteboardsController {
  constructor(private readonly whiteboards: WhiteboardsService) {}

  @Get()
  @RequirePermission("projects:view")
  listWhiteboards(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.listWhiteboards(u, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:whiteboards:manage")
  createWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createWhiteboardSchema)) body: CreateWhiteboardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.createWhiteboard(u, projectId, body);
  }

  @Get(":whiteboardId")
  @RequirePermission("projects:view")
  getWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.getWhiteboard(u, projectId, whiteboardId);
  }

  @Patch(":whiteboardId")
  @RequirePermission("projects:whiteboards:manage")
  updateWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @Body(new ZodValidationPipe(updateWhiteboardSchema)) body: UpdateWhiteboardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.updateWhiteboard(u, projectId, whiteboardId, body);
  }

  @Delete(":whiteboardId")
  @RequirePermission("projects:whiteboards:manage")
  deleteWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.deleteWhiteboard(u, projectId, whiteboardId);
  }
}

@RequireModule("projects")
@Controller("projects/:projectId/pages")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Get()
  @RequirePermission("projects:view")
  listPages(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pages.listPages(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:workspace:manage")
  createPage(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createPageSchema)) body: CreatePageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pages.createPage(u.orgId, u.userId, projectId, body);
  }

  @Patch(":pageId")
  @RequirePermission("projects:workspace:manage")
  updatePage(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body(new ZodValidationPipe(updatePageSchema)) body: UpdatePageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pages.updatePage(u.orgId, pageId, body);
  }

  @Delete(":pageId")
  @RequirePermission("projects:workspace:manage")
  deletePage(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pages.deletePage(u.orgId, pageId);
  }
}
