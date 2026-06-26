import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrGrowthService } from "./hr-growth.service";
import {
  createLearningPathSchema,
  learningPathListQuerySchema,
  type CreateLearningPathInput,
  type LearningPathListQuery,
} from "./dto/growth.schemas";

@Controller("hr/learning-paths")
@UseGuards(JwtAuthGuard)
export class HrLearningPathsController {
  constructor(private readonly growth: HrGrowthService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(learningPathListQuerySchema)) query: LearningPathListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.growth.listLearningPaths(u.orgId, query.limit);
  }

  @Post()
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "hr:performance")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createLearningPathSchema)) body: CreateLearningPathInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.growth.createLearningPath(u.orgId, u.userId, body);
  }
}
