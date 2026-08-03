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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AccessService } from "../../access/access.service";
import { OnboardingViewsService } from "./onboarding-views.service";
import {
  createOnboardingDocSchema,
  listOnboardingDocsQuerySchema,
  onboardingDocsSummaryQuerySchema,
  reviewOnboardingDocSchema,
  type CreateOnboardingDocInput,
  type ListOnboardingDocsQueryInput,
  type OnboardingDocsSummaryQueryInput,
  type ReviewOnboardingDocInput,
} from "./dto/hr-lifecycle.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/onboarding-docs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OnboardingViewsController {
  constructor(
    private readonly onboardingViews: OnboardingViewsService,
    private readonly access: AccessService,
  ) {}

  private async canManageOnboarding(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:onboarding:manage");
  }

  @Get("summary")
  @RequirePermission("hr:onboarding:manage")
  summary(
    @Query(new ZodValidationPipe(onboardingDocsSummaryQuerySchema)) query: OnboardingDocsSummaryQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboardingViews.summary(u.orgId, query);
  }

  @Get("me")
  @RequirePermission("self:onboarding-docs")
  listMine(
    @Query(new ZodValidationPipe(listOnboardingDocsQuerySchema)) query: ListOnboardingDocsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboardingViews.list(u.orgId, u.userId, false, query);
  }

  @Get()
  @RequirePermission("self:onboarding-docs")
  async list(
    @Query(new ZodValidationPipe(listOnboardingDocsQuerySchema)) query: ListOnboardingDocsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboardingViews.list(
      u.orgId,
      u.userId,
      await this.canManageOnboarding(u),
      query,
    );
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("self:onboarding-docs")
  create(
    @Body(new ZodValidationPipe(createOnboardingDocSchema)) body: CreateOnboardingDocInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const canManage = u.isOrgOwner || (u.permissions ?? []).includes("hr:onboarding:manage");
    return this.onboardingViews.create(u.orgId, u.userId, canManage, body);
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
