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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbPageReviewsService } from "./kb-page-reviews.service";
import {
  approveReviewSchema,
  createPageReviewSchema,
  rejectReviewSchema,
  type ApproveReviewInput,
  type CreatePageReviewInput,
  type RejectReviewInput,
} from "./dto/kb-page-reviews.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbPageReviewsController {
  constructor(private readonly reviews: KbPageReviewsService) {}

  @Get("page-reviews")
  @RequirePermission("kb:reviews:view")
  async list(
    @Query("status") status: string | undefined,
    @Query("type") type: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviews.list(u.orgId, status, type);
  }

  @Get("page-reviews/due")
  @RequirePermission("kb:reviews:view")
  async listDue(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.reviews.listDue(u.orgId);
  }

  @Post("pages/:pageId/reviews")
  @RequirePermission("kb:reviews:manage")
  async create(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body(new ZodValidationPipe(createPageReviewSchema)) body: CreatePageReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviews.create(u, pageId, body);
  }

  @Post("page-reviews/:reviewId/approve")
  @HttpCode(200)
  @RequirePermission("kb:reviews:manage")
  async approve(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body(new ZodValidationPipe(approveReviewSchema)) body: ApproveReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviews.approve(u, reviewId, body);
  }

  @Post("page-reviews/:reviewId/reject")
  @HttpCode(200)
  @RequirePermission("kb:reviews:manage")
  async reject(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body(new ZodValidationPipe(rejectReviewSchema)) body: RejectReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.reviews.reject(u, reviewId, body);
  }
}
