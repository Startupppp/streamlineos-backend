import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AllowNoOrg } from "../../common/auth/allow-no-org.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  OnboardingService,
  isInitiateAlreadyDone,
  isInitiateUserNotFound,
} from "./onboarding.service";
import {
  bankDetailsSchema,
  createTemplateSchema,
  initiateSchema,
  personalDetailsSchema,
  updateTaskSchema,
  type BankDetailsInput,
  type CreateTemplateInput,
  type InitiateInput,
  type PersonalDetailsInput,
  type UpdateTaskInput,
} from "./dto/onboarding.schemas";
import { ModuleRecommendationService } from "../onboarding-flow/module-recommendation.service";
import { ModuleChecklistService } from "../onboarding-flow/module-checklist.service";
import { GuidedTourService } from "../onboarding-flow/guided-tour.service";
import { OnboardingSessionService } from "../onboarding-flow/onboarding-session.service";
import {
  checklistItemSkipSchema,
  moduleRecommendationInputSchema,
  sessionPatchSchema,
  tourProgressSchema,
  type ChecklistItemSkipInput,
  type ModuleRecommendationInput,
  type SessionPatchInput,
  type TourProgressInput,
} from "../onboarding-flow/dto/onboarding-flow.schemas";

@Controller("onboarding")
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly moduleRecommendations: ModuleRecommendationService,
    private readonly checklists: ModuleChecklistService,
    private readonly tours: GuidedTourService,
    private readonly sessions: OnboardingSessionService,
    private readonly access: AccessService,
  ) {}

  // NOTE: every static route below must stay ABOVE `getUserTasks` (`GET /onboarding/:userId`,
  // near the bottom of this class) — it's a catch-all that would otherwise shadow these paths.

  /**
   * The generic onboarding:module-checklists:* permission is granted to every role (baseline
   * self-service bundle) so every module's checklist works out of the box.
   * The HR module checklist is the one exception — it must be HR-only (task requirement) — so
   * we layer an additional, existing-permission check on top for moduleKey === "HR" only,
   * matching the manual-OR-check idiom already used in hr-config/hr-document-types.controller.ts.
   */
  private async assertHrChecklistAccess(u: CurrentUserContext, mode: "view" | "manage") {
    if (u.isOrgOwner || u.isPlatformAdmin) return;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    if (perms.has("hr:employees:manage")) return;
    if (mode === "view" && perms.has("hr:employees:view")) return;
    throw new ForbiddenException("HR setup checklist requires HR permissions");
  }

  private async hasHrChecklistAccess(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner || u.isPlatformAdmin) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:employees:view") || perms.has("hr:employees:manage");
  }

  @Get("session")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:tasks:view")
  getOnboardingSession(@CurrentUser() u: CurrentUserContext) {
    return this.sessions.getOrCreateSession(u.orgId, u.userId, "employee_onboarding");
  }

  @Patch("session")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:tasks:complete")
  patchOnboardingSession(
    @Body(new ZodValidationPipe(sessionPatchSchema)) body: SessionPatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sessions.patchSession(u.orgId, u.userId, "employee_onboarding", body);
  }

  @Post("module-recommendations")
  @AllowNoOrg()
  @HttpCode(200)
  getModuleRecommendations(
    @Body(new ZodValidationPipe(moduleRecommendationInputSchema)) body: ModuleRecommendationInput,
  ) {
    return this.moduleRecommendations.recommend(body);
  }

  @Get("module-checklists")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:view")
  async listModuleChecklists(@CurrentUser() u: CurrentUserContext) {
    const includeHr = await this.hasHrChecklistAccess(u);
    return this.checklists.listChecklists(u.orgId, u.enabledModules, includeHr);
  }

  @Get("module-checklists/:moduleKey")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:view")
  async getModuleChecklist(@Param("moduleKey") moduleKey: string, @CurrentUser() u: CurrentUserContext) {
    if (moduleKey === "HR") await this.assertHrChecklistAccess(u, "view");
    return this.checklists.getChecklist(u.orgId, moduleKey, u.enabledModules);
  }

  @Post("module-checklists/:moduleKey/items/:itemKey/complete")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  async completeChecklistItem(
    @Param("moduleKey") moduleKey: string,
    @Param("itemKey") itemKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (moduleKey === "HR") await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.completeItem(u.orgId, moduleKey, itemKey, u.userId, u.enabledModules);
  }

  @Post("module-checklists/:moduleKey/items/:itemKey/skip")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  async skipChecklistItem(
    @Param("moduleKey") moduleKey: string,
    @Param("itemKey") itemKey: string,
    @Body(new ZodValidationPipe(checklistItemSkipSchema)) body: ChecklistItemSkipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (moduleKey === "HR") await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.skipItem(u.orgId, moduleKey, itemKey, u.userId, u.enabledModules, body.reason);
  }

  @Post("module-checklists/:moduleKey/dismiss")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  async dismissModuleChecklist(@Param("moduleKey") moduleKey: string, @CurrentUser() u: CurrentUserContext) {
    if (moduleKey === "HR") await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.dismissChecklist(u.orgId, moduleKey, u.userId, u.enabledModules);
  }

  @Post("module-checklists/:moduleKey/restart")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  async restartModuleChecklist(@Param("moduleKey") moduleKey: string, @CurrentUser() u: CurrentUserContext) {
    if (moduleKey === "HR") await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.restartChecklist(u.orgId, moduleKey, u.userId, u.enabledModules);
  }

  @Get("tours")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  listTours(@CurrentUser() u: CurrentUserContext) {
    return this.tours.listToursForUser(u.orgId, u.userId, u.role);
  }

  @Post("tours/:tourKey/progress")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  saveTourProgress(
    @Param("tourKey") tourKey: string,
    @Body(new ZodValidationPipe(tourProgressSchema)) body: TourProgressInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tours.saveProgress(u.orgId, u.userId, tourKey, body.currentStep);
  }

  @Post("tours/:tourKey/complete")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  completeTour(@Param("tourKey") tourKey: string, @CurrentUser() u: CurrentUserContext) {
    return this.tours.completeTour(u.orgId, u.userId, tourKey);
  }

  @Post("tours/:tourKey/dismiss")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  dismissTour(@Param("tourKey") tourKey: string, @CurrentUser() u: CurrentUserContext) {
    return this.tours.dismissTour(u.orgId, u.userId, tourKey);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:onboarding:manage")
  getProgress(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.getProgressSummary(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:onboarding:manage")
  async initiate(
    @Body(new ZodValidationPipe(initiateSchema)) body: InitiateInput,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.onboarding.initiate(u.orgId, body);
    if (isInitiateUserNotFound(result)) {
      throw new NotFoundException("User not found in this organization");
    }
    if (isInitiateAlreadyDone(result)) {
      throw new ConflictException("Onboarding already initiated for this user");
    }
    res.status(result.fromTemplate ? 200 : 201);
    return { success: true, tasksCreated: result.tasksCreated };
  }

  @Get("templates")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:onboarding:manage")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.listTemplates(u.orgId);
  }

  @Post("templates")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:onboarding:manage")
  @HttpCode(201)
  createTemplate(
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.createTemplate(u.orgId, u.userId, body);
  }

  @Post("reminders")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  sendReminders(@CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    const protocol = req.headers["x-forwarded-proto"] ?? req.protocol ?? "https";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const appUrl = host ? `${String(protocol)}://${String(host)}` : (process.env.APP_URL ?? "").replace(/\/$/, "");
    return this.onboarding.sendReminders(u.orgId, appUrl);
  }

  @Patch("personal-details")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:tasks:complete")
  savePersonalDetails(
    @Body(new ZodValidationPipe(personalDetailsSchema)) body: PersonalDetailsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.savePersonalDetails(u.orgId, u.userId, body);
  }

  @Patch("bank-details")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:tasks:complete")
  saveBankDetails(
    @Body(new ZodValidationPipe(bankDetailsSchema)) body: BankDetailsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.saveBankDetails(u.orgId, u.userId, body);
  }

  @Post("submit")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:tasks:complete")
  submit(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.submit(u.orgId, u.userId);
  }

  @Patch("tasks/:taskId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:tasks:complete")
  updateTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body(new ZodValidationPipe(updateTaskSchema)) body: UpdateTaskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.updateTask(u, taskId, body);
  }

  @Get("status")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:tasks:view")
  getStatus(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.getStatus(u.userId, u.orgId);
  }

  @Get(":userId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:tasks:view")
  getUserTasks(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.getUserTasks(u, userId);
  }
}
