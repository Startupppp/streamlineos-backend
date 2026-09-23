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
  bulkDecidePageReviewsSchema,
  createPageReviewSchema,
  listPageReviewsQuerySchema,
  rejectReviewSchema,
  type ApproveReviewInput,
  type BulkDecidePageReviewsInput,
  type CreatePageReviewInput,
  type ListPageReviewsQuery,
  type RejectReviewInput,
} from "./dto/kb-page-reviews.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  bulkDecideResultSchema,
  kbPageReviewListPageSchema,
  kbPageReviewWithContextSchema,
} from "./dto/kb-wiki-response.schemas";
import { z } from "zod";

const pageIdParams = z
  .object({ pageId: z.coerce.number().int().positive() })
  .strict();
const reviewIdParams = z
  .object({ reviewId: z.coerce.number().int().positive() })
  .strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbPageReviewsController {
  constructor(
    private readonly reviews: KbPageReviewsService,
    private readonly reviewsQuery: KbPageReviewsQueryService,
  ) {}

  @Get("page-reviews")
  @RequirePermission("kb:reviews:view")
  @Validate({ query: listPageReviewsQuerySchema })
  @ResponseSchema(kbPageReviewListPageSchema)
  async list(
    @Query() query: ListPageReviewsQuery,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviewsQuery.list(u, query);
  }

  @Get("page-reviews/due")
  @RequirePermission("kb:reviews:view")
  @Validate({ query: listPageReviewsQuerySchema })
  @ResponseSchema(kbPageReviewListPageSchema)
  async listDue(
    @Query() query: ListPageReviewsQuery,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviewsQuery.list(u, { ...query, status: "overdue" });
  }

  @Post("page-reviews/bulk-decide")
  @RequirePermission("kb:reviews:manage")
  @HttpCode(200)
  @Validate({ body: bulkDecidePageReviewsSchema })
  @ResponseSchema(bulkDecideResultSchema)
  async bulkDecide(
    @Body() body: BulkDecidePageReviewsInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviews.bulkDecide(u, body);
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
