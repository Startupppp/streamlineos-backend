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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const employmentIdParams = z.object({ employmentId: z.coerce.number().int().positive() }).strict();
const reviewIdParams = z.object({ reviewId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/probation")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProbationController {
  constructor(private readonly probation: ProbationService) {}

  @Get()
  @RequirePermission("hr:probation:view")
  @Validate({ query: listProbationReviewsSchema })
  listDueForReview(
    @CurrentUser() currentUser: CurrentUserContext,
    @Query() query: ListProbationReviewsInput,
  ) {
    return this.probation.listDueForReview(currentUser.orgId, query);
  }

  @Post(":employmentId/start-review")
  @HttpCode(200)
  @RequirePermission("hr:probation:manage")
  @Validate({ params: employmentIdParams, body: startReviewSchema })
  startReview(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @Body() body: StartReviewInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.probation.startReview(currentUser.orgId, currentUser.userId, employmentId, body);
  }

  @Post(":reviewId/extend")
  @HttpCode(200)
  @RequirePermission("hr:probation:manage")
  @Validate({ params: reviewIdParams, body: extendProbationSchema })
  extend(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body() body: ExtendProbationInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.probation.extend(currentUser.orgId, currentUser.userId, reviewId, body);
  }

  @Post(":reviewId/confirm")
  @HttpCode(200)
  @RequirePermission("hr:probation:manage")
  @Validate({ params: reviewIdParams, body: confirmProbationSchema })
  confirm(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body() body: ConfirmProbationInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.probation.confirm(currentUser.orgId, currentUser.userId, reviewId, body);
  }
}
