import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ProbationService } from "./probation.service";
import {
  startReviewSchema,
  extendProbationSchema,
  confirmProbationSchema,
  type StartReviewInput,
  type ExtendProbationInput,
  type ConfirmProbationInput,
} from "./dto/probation.schemas";

@RequireModule("hr")
@Controller("hr/probation")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProbationController {
  constructor(private readonly probation: ProbationService) {}

  @Get()
  @RequirePermission("hr:probation:view")
  listDueForReview(@CurrentUser() u: CurrentUserContext) {
    return this.probation.listDueForReview(u.orgId);
  }

  @Post(":employmentId/start-review")
  @HttpCode(200)
  @RequirePermission("hr:probation:manage")
  startReview(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @Body(new ZodValidationPipe(startReviewSchema)) body: StartReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.probation.startReview(u.orgId, u.userId, employmentId, body);
  }

  @Post(":reviewId/extend")
  @HttpCode(200)
  @RequirePermission("hr:probation:manage")
  extend(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body(new ZodValidationPipe(extendProbationSchema)) body: ExtendProbationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.probation.extend(u.orgId, u.userId, reviewId, body);
  }

  @Post(":reviewId/confirm")
  @HttpCode(200)
  @RequirePermission("hr:probation:manage")
  confirm(
    @Param("reviewId", ParseIntPipe) reviewId: number,
    @Body(new ZodValidationPipe(confirmProbationSchema)) body: ConfirmProbationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.probation.confirm(u.orgId, u.userId, reviewId, body);
  }
}
