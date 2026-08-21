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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ProbationService } from "./probation.service";
import {
  startReviewSchema,
  extendProbationSchema,
  confirmProbationSchema,
  listProbationReviewsSchema,
  type StartReviewInput,
  type ExtendProbationInput,
  type ConfirmProbationInput,
  type ListProbationReviewsInput,
} from "./dto/probation.schemas";

@RequireModule("hr")
@Controller("hr/probation")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProbationController {
  constructor(private readonly probation: ProbationService) {}

  @Get()
  @RequirePermission("hr:probation:view")
  listDueForReview(
    @CurrentUser() currentUser: CurrentUserContext,
    @Query(new ZodValidationPipe(listProbationReviewsSchema)) query: ListProbationReviewsInput,
  ) {
    return this.probation.listDueForReview(currentUser.orgId, query);
  }

  @Post(":employmentId/start-review")
  @HttpCode(200)
  @RequirePermission("hr:probation:manage")
  startReview(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @Body(new ZodValidationPipe(startReviewSchema)) body: StartReviewInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.probation.startReview(currentUser.orgId, currentUser.userId, employmentId, body);
  }

  @Post(":reviewId/extend")
  @HttpCode(200)
  @RequirePermission("hr:probation:manage")
  extend(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body(new ZodValidationPipe(extendProbationSchema)) body: ExtendProbationInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.probation.extend(currentUser.orgId, currentUser.userId, reviewId, body);
  }

  @Post(":reviewId/confirm")
  @HttpCode(200)
  @RequirePermission("hr:probation:manage")
  confirm(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body(new ZodValidationPipe(confirmProbationSchema)) body: ConfirmProbationInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.probation.confirm(currentUser.orgId, currentUser.userId, reviewId, body);
  }
}
