import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
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
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const docIdParams = z.object({ docId: z.coerce.number().int().positive() }).strict();

@Controller("hr/onboarding-docs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OnboardingViewsController {
  constructor(
    private readonly onboardingViews: OnboardingViewsService,
    private readonly access: AccessService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  private async canManageOnboarding(currentUser: CurrentUserContext): Promise<boolean> {
    if (currentUser.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(currentUser.orgId, currentUser.userId);
    return perms.has("hr:onboarding:manage");
  }

  @Get("summary")
  @RequirePermission("hr:onboarding:manage")
  @Validate({ query: onboardingDocsSummaryQuerySchema })
  async summary(
    @Query() query: OnboardingDocsSummaryQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveOnboardingManageScope(this.access, currentUser);
    return this.onboardingViews.summary(currentUser.orgId, query, scope, currentUser.userId);
  }

  @Get("me")
  @RequirePermission("self:onboarding-docs")
  @Validate({ query: listOnboardingDocsQuerySchema })
  listMine(
    @Query() query: ListOnboardingDocsQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.onboardingViews.list(currentUser.orgId, currentUser.userId, false, query, "own");
  }

  @Post("me")
  @HttpCode(201)
  @RequirePermission("self:onboarding-docs")
  @Validate({ body: createOwnOnboardingDocSchema })
  createMine(
    @Body()
    body: CreateOwnOnboardingDocInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.onboardingViews.create(currentUser.orgId, currentUser.userId, false, body, "own");
  }

  @Get("me/:docId/file")
  @RequirePermission("self:onboarding-docs")
  @Validate({ params: docIdParams })
  getMyFile(
    @Param("docId", ParseIntPipe) docId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.signFile(currentUser, docId, "own");
  }

  @Get()
  @RequirePermission("hr:onboarding:manage")
  @Validate({ query: listOnboardingDocsQuerySchema })
  async list(
    @Query() query: ListOnboardingDocsQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const isAdmin = await this.canManageOnboarding(currentUser);
    const scope = isAdmin ? await resolveOnboardingManageScope(this.access, currentUser) : "own";
    return this.onboardingViews.list(currentUser.orgId, currentUser.userId, isAdmin, query, scope);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:onboarding:manage")
  @Validate({ body: createOnboardingDocSchema })
  async create(
    @Body() body: CreateOnboardingDocInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const canManage = await this.canManageOnboarding(currentUser);
    const scope = canManage ? await resolveOnboardingManageScope(this.access, currentUser) : "own";
    return this.onboardingViews.create(currentUser.orgId, currentUser.userId, canManage, body, scope);
  }

  @Get(":docId/file")
  @RequirePermission("hr:onboarding:manage")
  @Validate({ params: docIdParams })
  async getFile(
    @Param("docId", ParseIntPipe) docId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveOnboardingManageScope(this.access, currentUser);
    return this.signFile(currentUser, docId, scope);
  }

  @Patch(":docId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:manage")
  @Validate({ params: docIdParams, body: reviewOnboardingDocSchema })
  async review(
    @Param("docId", ParseIntPipe) docId: number,
    @Body() body: ReviewOnboardingDocInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveOnboardingManageScope(this.access, currentUser);
    return this.onboardingViews.review(currentUser.orgId, currentUser.userId, docId, body, scope);
  }

  private async signFile(
    currentUser: CurrentUserContext,
    docId: number,
    scope: DataScope,
  ): Promise<{ url: string; fileName: string; expiresIn: number }> {
    const document = await this.onboardingViews.getFileReference(
      currentUser.orgId,
      currentUser.userId,
      docId,
      scope,
    );
    const fileKey = this.storage.getFileKeyFromUrl(document.fileUrl);
    if (!this.storage.isValidFileKey(fileKey)) {
      throw new NotFoundException("Document file is unavailable.");
    }

    const expiresIn = 300;
    const url = await this.storage.getFileUrl(currentUser.orgId, fileKey, expiresIn);
    await this.audit.logCritical({
      action: "hr.onboarding_document_viewed",
      userId: currentUser.userId,
      orgId: currentUser.orgId,
      targetId: String(document.id),
      targetType: "onboarding_document",
      metadata: { fileName: document.fileName },
    });
    return { url, fileName: document.fileName, expiresIn };
  }
}
