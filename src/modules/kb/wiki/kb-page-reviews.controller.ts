import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { KbPageReviewsService } from "./kb-page-reviews.service";
import { KbPageReviewsQueryService } from "./kb-page-reviews-query.service";
import {
  approveReviewSchema,
  createPageReviewSchema,
  listDueReviewsQuerySchema,
  listReviewsQuerySchema,
  rejectReviewSchema,
  type ApproveReviewInput,
  type CreatePageReviewInput,
  type ListDueReviewsQuery,
  type ListReviewsQuery,
  type RejectReviewInput,
} from "./dto/kb-page-reviews.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  kbPageReviewListSchema,
  kbPageReviewWithContextSchema,
} from "./dto/kb-wiki-response.schemas";
import { z } from "zod";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();
const reviewIdParams = z.object({ reviewId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbPageReviewsController {
  constructor(
    private readonly reviews: KbPageReviewsService,
    private readonly reviewsQuery: KbPageReviewsQueryService,
  ) {}

  @Get("page-reviews")
  @RequirePermission("kb:reviews:view")
  @Validate({ query: listReviewsQuerySchema })
  @ResponseSchema(kbPageReviewListSchema)
  async list(
    @Query() query: ListReviewsQuery,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviewsQuery.list(u, query.status, query.type);
  }

  @Get("page-reviews/due")
  @RequirePermission("kb:reviews:view")
  @Validate({ query: listDueReviewsQuerySchema })
  @ResponseSchema(kbPageReviewListSchema)
  async listDue(
    @Query() query: ListDueReviewsQuery,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const cursor =
      query.afterDueAt && query.afterId
        ? { sortValue: query.afterDueAt, id: query.afterId }
        : undefined;
    return this.reviewsQuery.listDue(u, cursor);
  }

  @Post("pages/:pageId/reviews")
  @RequirePermission("kb:reviews:manage")
  @HttpCode(201)
  @Validate({ params: pageIdParams, body: createPageReviewSchema })
  @ResponseSchema(kbPageReviewWithContextSchema)
  async create(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: CreatePageReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviews.create(u, pageId, body);
  }

  @Post("page-reviews/:reviewId/approve")
  @Idempotent("kb.page-review.approve")
  @HttpCode(200)
  @RequirePermission("kb:reviews:manage")
  @Validate({ params: reviewIdParams, body: approveReviewSchema })
  @ResponseSchema(kbPageReviewWithContextSchema)
  async approve(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body() body: ApproveReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviews.approve(u, reviewId, body);
  }

  @Post("page-reviews/:reviewId/reject")
  @Idempotent("kb.page-review.reject")
  @HttpCode(200)
  @RequirePermission("kb:reviews:manage")
  @Validate({ params: reviewIdParams, body: rejectReviewSchema })
  @ResponseSchema(kbPageReviewWithContextSchema)
  async reject(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body() body: RejectReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviews.reject(u, reviewId, body);
  }
}
