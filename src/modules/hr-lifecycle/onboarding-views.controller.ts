import {
  Body,
  Controller,
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
import { OnboardingViewsService } from "./onboarding-views.service";
import { userCan } from "./ability.helper";
import {
  createOnboardingDocSchema,
  listOnboardingDocsQuerySchema,
  reviewOnboardingDocSchema,
  type CreateOnboardingDocInput,
  type ListOnboardingDocsQueryInput,
  type ReviewOnboardingDocInput,
} from "./dto/hr-lifecycle.schemas";

@Controller("hr/onboarding-docs")
@UseGuards(JwtAuthGuard)
export class OnboardingViewsController {
  constructor(private readonly onboardingViews: OnboardingViewsService) {}

  @Get("summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:manage")
  summary(@CurrentUser() u: CurrentUserContext) {
    return this.onboardingViews.summary(u.orgId);
  }

  @Get()
  list(
    @Query(new ZodValidationPipe(listOnboardingDocsQuerySchema)) query: ListOnboardingDocsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboardingViews.list(
      u.orgId,
      u.userId,
      userCan(u, "manage", "hr:documents"),
      query,
    );
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createOnboardingDocSchema)) body: CreateOnboardingDocInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboardingViews.create(
      u.orgId,
      u.userId,
      userCan(u, "manage", "hr:onboarding"),
      body,
    );
  }

  @Patch(":docId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:manage")
  review(
    @Param("docId", ParseIntPipe) docId: number,
    @Body(new ZodValidationPipe(reviewOnboardingDocSchema)) body: ReviewOnboardingDocInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboardingViews.review(u.orgId, u.userId, docId, body);
  }
}
