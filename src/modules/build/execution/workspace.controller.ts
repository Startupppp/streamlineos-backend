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
  listMilestonesQuerySchema,
  listViewsQuerySchema,
  listWhiteboardsQuerySchema,
  updateIntakeSchema,
  updateMilestoneSchema,
  updateViewSchema,
  updateWhiteboardSchema,
  type CreateIntakeInput,
  type CreateMilestoneInput,
  type CreateViewInput,
  type CreateWhiteboardInput,
  type IntakeListQuery,
  type ListMilestonesQuery,
  type ListViewsQuery,
  type ListWhiteboardsQuery,
  type UpdateIntakeInput,
  type UpdateMilestoneInput,
  type UpdateViewInput,
  type UpdateWhiteboardInput,
} from "./dto/workspace.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  milestonePageSchema,
  milestoneRowSchema,
  intakeItemSchema,
  intakeListSchema,
  viewPageSchema,
  viewRowSchema,
  whiteboardHubItemSchema,
  whiteboardListItemSchema,
  whiteboardListPageSchema,
  whiteboardDetailSchema,
} from "./dto/workspace-response.schemas";

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
  @ResponseSchema(milestonePageSchema)
  @Validate({ params: projectIdParams, query: listMilestonesQuerySchema })
  listMilestones(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListMilestonesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.listMilestones(u, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  @ResponseSchema(milestoneRowSchema)
  @Validate({ params: projectIdParams, body: createMilestoneSchema })
  createMilestone(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateMilestoneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.createMilestone(u, projectId, body);
  }

  @Patch(":milestoneId")
  @RequirePermission("build:workspace:manage")
  @ResponseSchema(milestoneRowSchema)
  @Validate({ params: projectAndMilestoneIdParams, body: updateMilestoneSchema })
  updateMilestone(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("milestoneId", ParseIntPipe) milestoneId: number,
    @Body() body: UpdateMilestoneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.updateMilestone(u, projectId, milestoneId, body);
  }

  @Delete(":milestoneId")
  @RequirePermission("build:workspace:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectAndMilestoneIdParams })
  deleteMilestone(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("milestoneId", ParseIntPipe) milestoneId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.deleteMilestone(u, projectId, milestoneId);
  }

  @Post(":milestoneId/restore")
  @RequirePermission("build:workspace:restore")
  @BodylessAction()
  @ResponseSchema(successSchema)
  @Validate({ params: projectAndMilestoneIdParams })
  restoreMilestone(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("milestoneId", ParseIntPipe) milestoneId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.milestones.restoreMilestone(u, projectId, milestoneId);
  }
}

@RequireModule("build")
@Controller("build/:projectId/intake")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Get()
  @RequirePermission("build:view")
  @ResponseSchema(intakeListSchema)
  @Validate({ params: projectIdParams, query: intakeListQuerySchema })
  listIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: IntakeListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.intake.listIntake(u, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  @ResponseSchema(intakeItemSchema)
  @Validate({ params: projectIdParams, body: createIntakeSchema })
  createIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateIntakeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.intake.createIntake(u, projectId, body);
  }

  @Patch(":requestId")
  @RequirePermission("build:workspace:manage")
  @ResponseSchema(intakeItemSchema)
  @Validate({ params: projectAndRequestIdParams, body: updateIntakeSchema })
  updateIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: UpdateIntakeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.intake.updateIntake(u, projectId, requestId, body);
  }
}

@RequireModule("build")
@Controller("build/:projectId/views")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  @RequirePermission("build:view")
  @ResponseSchema(viewPageSchema)
  @Validate({ params: projectIdParams, query: listViewsQuerySchema })
  listViews(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListViewsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.listViews(u, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  @ResponseSchema(viewRowSchema)
  @Validate({ params: projectIdParams, body: createViewSchema })
  createView(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.createView(u, projectId, body);
  }

  @Patch(":viewId")
  @RequirePermission("build:workspace:manage")
  @ResponseSchema(viewRowSchema)
  @Validate({ params: projectAndViewIdParams, body: updateViewSchema })
  updateView(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("viewId", ParseIntPipe) viewId: number,
    @Body() body: UpdateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.updateView(u, projectId, viewId, body);
  }

  @Delete(":viewId")
  @RequirePermission("build:workspace:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectAndViewIdParams })
  deleteView(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("viewId", ParseIntPipe) viewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.deleteView(u, projectId, viewId);
  }
}

@RequireModule("build")
@Controller("build/views")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WorkspaceViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  @RequirePermission("build:view")
  @ResponseSchema(z.array(viewRowSchema))
  listWorkspaceViews(@CurrentUser() u: CurrentUserContext) {
    return this.views.listWorkspaceViews(u.orgId, u.userId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspace:manage")
  @ResponseSchema(viewRowSchema)
  @Validate({ body: createViewSchema })
  createWorkspaceView(
    @Body() body: CreateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.createWorkspaceView(u.orgId, u.userId, body);
  }

  @Patch(":viewId")
  @RequirePermission("build:workspace:manage")
  @ResponseSchema(viewRowSchema)
  @Validate({ params: viewIdParams, body: updateViewSchema })
  updateWorkspaceView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @Body() body: UpdateViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.updateWorkspaceView(u.orgId, u.userId, viewId, body);
  }

  @Delete(":viewId")
  @RequirePermission("build:workspace:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: viewIdParams })
  deleteWorkspaceView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.views.deleteWorkspaceView(u.orgId, u.userId, viewId);
  }
}

@RequireModule("build")
@Controller("build/whiteboards")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WhiteboardsHubController {
  constructor(private readonly whiteboards: WhiteboardsService) {}

  @Get()
  @RequirePermission("build:view")
  @ResponseSchema(z.array(whiteboardHubItemSchema))
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
  @ResponseSchema(whiteboardListPageSchema)
  @Validate({ params: projectIdParams, query: listWhiteboardsQuerySchema })
  listWhiteboards(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListWhiteboardsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.listWhiteboards(u, projectId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:whiteboards:manage")
  @ResponseSchema(whiteboardDetailSchema)
  @Validate({ params: projectIdParams, body: createWhiteboardSchema })
  createWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateWhiteboardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.createWhiteboard(u, projectId, body);
  }

  @Get(":whiteboardId")
  @RequirePermission("build:view")
  @ResponseSchema(whiteboardDetailSchema)
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
  @ResponseSchema(whiteboardDetailSchema)
  @Validate({ params: projectAndWhiteboardIdParams, body: updateWhiteboardSchema })
  updateWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @Body() body: UpdateWhiteboardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.updateWhiteboard(u, projectId, whiteboardId, body);
  }

  @Delete(":whiteboardId")
  @RequirePermission("build:whiteboards:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectAndWhiteboardIdParams })
  deleteWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.deleteWhiteboard(u, projectId, whiteboardId);
  }

  @Post(":whiteboardId/restore")
  @RequirePermission("build:whiteboards:restore")
  @BodylessAction()
  @ResponseSchema(successSchema)
  @Validate({ params: projectAndWhiteboardIdParams })
  restoreWhiteboard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("whiteboardId", ParseIntPipe) whiteboardId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whiteboards.restoreWhiteboard(u, projectId, whiteboardId);
  }
}
