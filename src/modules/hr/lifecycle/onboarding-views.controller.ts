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
import { resolveOnboardingManageScope } from "./onboarding-scope";
import {
  createOnboardingDocSchema,
  createOwnOnboardingDocSchema,
  listOnboardingDocsQuerySchema,
  onboardingDocsSummaryQuerySchema,
  reviewOnboardingDocSchema,
  type CreateOnboardingDocInput,
  type CreateOwnOnboardingDocInput,
  type ListOnboardingDocsQueryInput,
  type OnboardingDocsSummaryQueryInput,
  type ReviewOnboardingDocInput,
} from "./dto/hr-lifecycle.schemas";

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
  async summary(
    @Query(new ZodValidationPipe(onboardingDocsSummaryQuerySchema)) query: OnboardingDocsSummaryQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveOnboardingManageScope(this.access, u);
    return this.onboardingViews.summary(u.orgId, query, scope, u.userId);
  }

  @Get("me")
  @RequirePermission("self:onboarding-docs")
  listMine(
    @Query(new ZodValidationPipe(listOnboardingDocsQuerySchema)) query: ListOnboardingDocsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboardingViews.list(u.orgId, u.userId, false, query, "own");
  }

  @Post("me")
  @HttpCode(201)
  @RequirePermission("self:onboarding-docs")
  createMine(
    @Body(new ZodValidationPipe(createOwnOnboardingDocSchema))
    body: CreateOwnOnboardingDocInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboardingViews.create(u.orgId, u.userId, false, body, "own");
  }

  @Get()
  @RequirePermission("hr:onboarding:manage")
  async list(
    @Query(new ZodValidationPipe(listOnboardingDocsQuerySchema)) query: ListOnboardingDocsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isAdmin = await this.canManageOnboarding(u);
    const scope = isAdmin ? await resolveOnboardingManageScope(this.access, u) : "own";
    return this.onboardingViews.list(u.orgId, u.userId, isAdmin, query, scope);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:onboarding:manage")
  async create(
    @Body(new ZodValidationPipe(createOnboardingDocSchema)) body: CreateOnboardingDocInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const canManage = await this.canManageOnboarding(u);
    const scope = canManage ? await resolveOnboardingManageScope(this.access, u) : "own";
    return this.onboardingViews.create(u.orgId, u.userId, canManage, body, scope);
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
