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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectAndMilestoneIdParams = z.object({ projectId: z.coerce.number().int().positive(), milestoneId: z.coerce.number().int().positive() }).strict();
const projectAndRequestIdParams = z.object({ projectId: z.coerce.number().int().positive(), requestId: z.coerce.number().int().positive() }).strict();
const projectAndViewIdParams = z.object({ projectId: z.coerce.number().int().positive(), viewId: z.coerce.number().int().positive() }).strict();
const viewIdParams = z.object({ viewId: z.coerce.number().int().positive() }).strict();
const projectAndWhiteboardIdParams = z.object({ projectId: z.coerce.number().int().positive(), whiteboardId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/milestones")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MilestonesController {
  constructor(private readonly milestones: MilestonesService) {}

  @Get()
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams })
  listMilestones(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.listMilestones(u.orgId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  @Validate({ params: projectIdParams })
  createMilestone(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createMilestoneSchema)) body: CreateMilestoneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.createMilestone(u.orgId, u.userId, projectId, body);
  }

  @Patch(":milestoneId")
  @RequirePermission("build:workspace:manage")
  @Validate({ params: projectAndMilestoneIdParams })
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
  @Validate({ params: projectAndMilestoneIdParams })
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
  @Validate({ params: projectIdParams })
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
  @Validate({ params: projectIdParams })
  createIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createIntakeSchema)) body: CreateIntakeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.intake.createIntake(u.orgId, projectId, body);
  }

  @Patch(":requestId")
  @RequirePermission("build:workspace:manage")
  @Validate({ params: projectAndRequestIdParams })
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
  @Validate({ params: projectIdParams })
  listViews(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.listViews(u.orgId, u.userId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  @Validate({ params: projectIdParams })
  createView(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createViewSchema)) body: CreateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.createView(u.orgId, u.userId, projectId, body);
  }

  @Patch(":viewId")
  @RequirePermission("build:workspace:manage")
  @Validate({ params: projectAndViewIdParams })
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
  @Validate({ params: projectAndViewIdParams })
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
  @Validate({ params: viewIdParams })
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
  @Validate({ params: viewIdParams })
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
  @Validate({ params: projectIdParams })
  listWhiteboards(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.listWhiteboards(u, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:whiteboards:manage")
  @Validate({ params: projectIdParams })
  createWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createWhiteboardSchema)) body: CreateWhiteboardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.createWhiteboard(u, projectId, body);
  }

  @Get(":whiteboardId")
  @RequirePermission("build:view")
  @Validate({ params: projectAndWhiteboardIdParams })
  getWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.getWhiteboard(u, projectId, whiteboardId);
  }

  @Patch(":whiteboardId")
  @RequirePermission("build:whiteboards:manage")
  @Validate({ params: projectAndWhiteboardIdParams })
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
  @Validate({ params: projectAndWhiteboardIdParams })
  deleteWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.deleteWhiteboard(u, projectId, whiteboardId);
  }
}

