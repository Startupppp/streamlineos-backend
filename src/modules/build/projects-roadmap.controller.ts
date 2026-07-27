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
import { ProjectsRoadmapService } from "./projects-roadmap.service";
import {
  changelogListQuerySchema,
  createChangelogSchema,
  createFeedbackSchema,
  createRoadmapSchema,
  feedbackListQuerySchema,
  roadmapListQuerySchema,
  updateChangelogSchema,
  updateFeedbackSchema,
  updateRoadmapSchema,
  type ChangelogListQuery,
  type CreateChangelogInput,
  type CreateFeedbackInput,
  type CreateRoadmapInput,
  type FeedbackListQuery,
  type RoadmapListQuery,
  type UpdateChangelogInput,
  type UpdateFeedbackInput,
  type UpdateRoadmapInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsRoadmapController {
  constructor(private readonly roadmap: ProjectsRoadmapService) {}

  @Get("roadmap")
  @RequirePermission("build:roadmap:view")
  listRoadmap(
    @Query(new ZodValidationPipe(roadmapListQuerySchema)) query: RoadmapListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.listRoadmap(u.orgId, query);
  }

  @Post("roadmap")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(201)
  createRoadmap(
    @Body(new ZodValidationPipe(createRoadmapSchema)) body: CreateRoadmapInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.createRoadmap(u.orgId, u.userId, body);
  }

  @Patch("roadmap/:itemId")
  @RequirePermission("build:roadmap:manage")
  updateRoadmap(
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body(new ZodValidationPipe(updateRoadmapSchema)) body: UpdateRoadmapInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.updateRoadmap(u.orgId, itemId, body);
  }

  @Delete("roadmap/:itemId")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(204)
  deleteRoadmap(
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.deleteRoadmap(u.orgId, itemId);
  }

  @Get("feedback")
  @RequirePermission("build:roadmap:view")
  listFeedback(
    @Query(new ZodValidationPipe(feedbackListQuerySchema)) query: FeedbackListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.listFeedback(u.orgId, query);
  }

  @Post("feedback")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(201)
  createFeedback(
    @Body(new ZodValidationPipe(createFeedbackSchema)) body: CreateFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.createFeedback(u.orgId, u.userId, body);
  }

  @Patch("feedback/:postId")
  @RequirePermission("build:roadmap:manage")
  updateFeedback(
    @Param("postId", ParseIntPipe) postId: number,
    @Body(new ZodValidationPipe(updateFeedbackSchema)) body: UpdateFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.updateFeedback(u.orgId, postId, body);
  }

  @Delete("feedback/:postId")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(204)
  deleteFeedback(
    @Param("postId", ParseIntPipe) postId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.deleteFeedback(u.orgId, postId);
  }

  @Get("changelog")
  @RequirePermission("build:roadmap:view")
  listChangelog(
    @Query(new ZodValidationPipe(changelogListQuerySchema)) query: ChangelogListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.listChangelog(u.orgId, query);
  }

  @Post("changelog")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(201)
  createChangelog(
    @Body(new ZodValidationPipe(createChangelogSchema)) body: CreateChangelogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.createChangelog(u.orgId, u.userId, body);
  }

  @Patch("changelog/:entryId")
  @RequirePermission("build:roadmap:manage")
  updateChangelog(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body(new ZodValidationPipe(updateChangelogSchema)) body: UpdateChangelogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.updateChangelog(u.orgId, entryId, body);
  }

  @Delete("changelog/:entryId")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(204)
  deleteChangelog(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.deleteChangelog(u.orgId, entryId);
  }
}
