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
import { ProjectsRoadmapService } from "./projects-roadmap.service";
import {
  changelogListQuerySchema,
  createChangelogSchema,
  createFeedbackSchema,
  createRoadmapSchema,
  feedbackListQuerySchema,
  roadmapListQuerySchema,
  updateChangelogSchema,
  mergeFeedbackSchema,
  updateFeedbackSchema,
  updateRoadmapSchema,
  type ChangelogListQuery,
  type CreateChangelogInput,
  type CreateFeedbackInput,
  type CreateRoadmapInput,
  type FeedbackListQuery,
  type RoadmapListQuery,
  type UpdateChangelogInput,
  type MergeFeedbackInput,
  type UpdateFeedbackInput,
  type UpdateRoadmapInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";
import {
  roadmapItemSchema,
  roadmapPageSchema,
  feedbackPostSchema,
  changelogEntrySchema,
} from "./dto/build-roadmap-response.schemas";

const itemIdParams = z.object({ itemId: z.coerce.number().int().positive() }).strict();
const postIdParams = z.object({ postId: z.coerce.number().int().positive() }).strict();
const entryIdParams = z.object({ entryId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsRoadmapController {
  constructor(private readonly roadmap: ProjectsRoadmapService) {}

  @Get("roadmap")
  @RequirePermission("build:roadmap:view")
  @ResponseSchema(roadmapPageSchema)
  @Validate({ query: roadmapListQuerySchema })
  listRoadmap(
    @Query() query: RoadmapListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.listRoadmap(u.orgId, query);
  }

  @Post("roadmap")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(201)
  @ResponseSchema(roadmapItemSchema)
  @Validate({ body: createRoadmapSchema })
  createRoadmap(
    @Body() body: CreateRoadmapInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.createRoadmap(u.orgId, u.userId, body);
  }

  @Patch("roadmap/:itemId")
  @RequirePermission("build:roadmap:manage")
  @ResponseSchema(roadmapItemSchema)
  @Validate({ params: itemIdParams, body: updateRoadmapSchema })
  updateRoadmap(
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() body: UpdateRoadmapInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.updateRoadmap(u.orgId, itemId, body);
  }

  @Delete("roadmap/:itemId")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: itemIdParams })
  deleteRoadmap(
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.deleteRoadmap(u.orgId, itemId);
  }

  @Get("feedback")
  @RequirePermission("build:roadmap:view")
  @ResponseSchema(cursorPageSchema(feedbackPostSchema))
  @Validate({ query: feedbackListQuerySchema })
  listFeedback(
    @Query() query: FeedbackListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.listFeedback(u.orgId, query);
  }

  @Post("feedback")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(201)
  @ResponseSchema(feedbackPostSchema)
  @Validate({ body: createFeedbackSchema })
  createFeedback(
    @Body() body: CreateFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.createFeedback(u.orgId, u.userId, body);
  }

  @Patch("feedback/:postId")
  @RequirePermission("build:roadmap:manage")
  @ResponseSchema(feedbackPostSchema)
  @Validate({ params: postIdParams, body: updateFeedbackSchema })
  updateFeedback(
    @Param("postId", ParseIntPipe) postId: number,
    @Body() body: UpdateFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.updateFeedback(u.orgId, postId, body);
  }

  @Post("feedback/:postId/merge")
  @RequirePermission("build:roadmap:manage")
  @ResponseSchema(feedbackPostSchema)
  @Validate({ params: postIdParams, body: mergeFeedbackSchema })
  mergeFeedback(
    @Param("postId", ParseIntPipe) postId: number,
    @Body() body: MergeFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.mergeFeedback(u.orgId, postId, body);
  }

  @Delete("feedback/:postId")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: postIdParams })
  deleteFeedback(
    @Param("postId", ParseIntPipe) postId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.deleteFeedback(u.orgId, postId);
  }

  @Get("changelog")
  @RequirePermission("build:roadmap:view")
  @ResponseSchema(cursorPageSchema(changelogEntrySchema))
  @Validate({ query: changelogListQuerySchema })
  listChangelog(
    @Query() query: ChangelogListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.listChangelog(u.orgId, query);
  }

  @Post("changelog")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(201)
  @ResponseSchema(changelogEntrySchema)
  @Validate({ body: createChangelogSchema })
  createChangelog(
    @Body() body: CreateChangelogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.createChangelog(u.orgId, u.userId, body);
  }

  @Patch("changelog/:entryId")
  @RequirePermission("build:roadmap:manage")
  @ResponseSchema(changelogEntrySchema)
  @Validate({ params: entryIdParams, body: updateChangelogSchema })
  updateChangelog(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body() body: UpdateChangelogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.updateChangelog(u.orgId, entryId, body);
  }

  @Delete("changelog/:entryId")
  @RequirePermission("build:roadmap:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: entryIdParams })
  deleteChangelog(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.roadmap.deleteChangelog(u.orgId, entryId);
  }
}
