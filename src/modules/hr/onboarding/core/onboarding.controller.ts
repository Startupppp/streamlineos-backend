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
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../../common/auth/universal.decorator";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { AccessService } from "../../../access/access.service";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import {
  OnboardingService,
  isInitiateAlreadyDone,
  isInitiateUserNotFound,
} from "./onboarding.service";
import { OnboardingRequirementsService } from "./onboarding-requirements.service";
import {
  bankDetailsSchema,
  createTemplateSchema,
  ensureDocumentsSchema,
  initiateSchema,
  personalDetailsSchema,
  requirementsQuerySchema,
  updateTaskSchema,
  type BankDetailsInput,
  type CreateTemplateInput,
  type EnsureDocumentsInput,
  type InitiateInput,
  type PersonalDetailsInput,
  type RequirementsQueryInput,
  type UpdateTaskInput,
} from "./dto/onboarding.schemas";
import { ModuleChecklistService } from "../flow/module-checklist.service";
import {
  GuidedTourService,
  HR_SETUP_TOUR_KEY,
} from "../flow/guided-tour.service";
import type { ModuleKey } from "../../../../common/rbac/module-vocabulary";
import { OnboardingSessionService } from "../flow/onboarding-session.service";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import {
  checklistItemSkipSchema,
  sessionPatchSchema,
  tourProgressSchema,
  type ChecklistItemSkipInput,
  type SessionPatchInput,
  type TourProgressInput,
} from "../flow/dto/onboarding-flow.schemas";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";

const moduleKeyParams = z.object({ moduleKey: z.string().min(1) }).strict();
const moduleKeyitemKeyParams = z.object({ moduleKey: z.string().min(1), itemKey: z.string().min(1) }).strict();
const tourKeyParams = z.object({ tourKey: z.string().min(1) }).strict();
const taskIdParams = z.object({ taskId: z.coerce.number().int().positive() }).strict();
const userIdParams = z.object({ userId: z.string().min(1) }).strict();

const HR_MODULE_KEY: ModuleKey = "hr";

@Controller("onboarding")
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly requirements: OnboardingRequirementsService,
    private readonly checklists: ModuleChecklistService,
    private readonly tours: GuidedTourService,
    private readonly sessions: OnboardingSessionService,
    private readonly access: AccessService,
  ) {}

  private isHrModuleKey(moduleKey: string): boolean {
    return moduleKey.toLowerCase() === HR_MODULE_KEY;
  }

  private async assertHrChecklistAccess(
    u: CurrentUserContext,
    mode: "view" | "manage",
  ) {
    if (u.isOrgOwner) return;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    if (perms.has("hr:employees:manage")) return;
    if (mode === "view" && perms.has("hr:employees:view")) return;
    throw new ForbiddenException("HR setup checklist requires HR permissions");
  }

  private async hasHrChecklistAccess(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:employees:view") || perms.has("hr:employees:manage");
  }

  @Get("session")
  @Universal()
  getOnboardingSession(@CurrentUser() u: CurrentUserContext) {
    return this.sessions.getOrCreateSession(
      u.orgId,
      u.userId,
      "employee_onboarding",
    );
  }

  @Patch("session")
  @Universal()
  @Validate({ body: sessionPatchSchema })
  patchOnboardingSession(
    @Body() body: SessionPatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sessions.patchSession(
      u.orgId,
      u.userId,
      "employee_onboarding",
      body,
    );
  }

  @Get("module-checklists")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:view")
  async listModuleChecklists(@CurrentUser() u: CurrentUserContext) {
    const includeHr = await this.hasHrChecklistAccess(u);
    return this.checklists.listChecklists(u.orgId, includeHr);
  }

  @Get("module-checklists/:moduleKey")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:view")
  @Validate({ params: moduleKeyParams })
  async getModuleChecklist(
    @Param("moduleKey") moduleKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.isHrModuleKey(moduleKey)) await this.assertHrChecklistAccess(u, "view");
    return this.checklists.getChecklist(u.orgId, moduleKey);
  }

  @Post("module-checklists/:moduleKey/items/:itemKey/complete")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  @Validate({ params: moduleKeyitemKeyParams })
  async completeChecklistItem(
    @Param("moduleKey") moduleKey: string,
    @Param("itemKey") itemKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.isHrModuleKey(moduleKey)) await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.completeItem(
      u.orgId,
      moduleKey,
      itemKey,
      u.userId,
    );
  }

  @Post("module-checklists/:moduleKey/items/:itemKey/skip")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  @Validate({ params: moduleKeyitemKeyParams, body: checklistItemSkipSchema })
  async skipChecklistItem(
    @Param("moduleKey") moduleKey: string,
    @Param("itemKey") itemKey: string,
    @Body() body: ChecklistItemSkipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.isHrModuleKey(moduleKey)) await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.skipItem(
      u.orgId,
      moduleKey,
      itemKey,
      u.userId,
      body.reason,
    );
  }

  @Post("module-checklists/:moduleKey/dismiss")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  @Validate({ params: moduleKeyParams })
  async dismissModuleChecklist(
    @Param("moduleKey") moduleKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.isHrModuleKey(moduleKey)) await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.dismissChecklist(
      u.orgId,
      moduleKey,
      u.userId,
    );
  }

  @Post("module-checklists/:moduleKey/restart")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  @Validate({ params: moduleKeyParams })
  async restartModuleChecklist(
    @Param("moduleKey") moduleKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.isHrModuleKey(moduleKey)) await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.restartChecklist(
      u.orgId,
      moduleKey,
      u.userId,
    );
  }

  private async assertTourAccess(
    tourKey: string,
    u: CurrentUserContext,
    mode: "view" | "manage",
  ) {
    if (tourKey === HR_SETUP_TOUR_KEY)
      await this.assertHrChecklistAccess(u, mode);
  }

  @Get("tours")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  async listTours(@CurrentUser() u: CurrentUserContext) {
    const tours = await this.tours.listToursForUser(u.orgId, u.userId, u.role);
    const includeHr = await this.hasHrChecklistAccess(u);
    return includeHr
      ? tours
      : tours.filter((t) => t.tourKey !== HR_SETUP_TOUR_KEY);
  }

  @Post("tours/:tourKey/progress")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  @Validate({ params: tourKeyParams, body: tourProgressSchema })
  async saveTourProgress(
    @Param("tourKey") tourKey: string,
    @Body() body: TourProgressInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertTourAccess(tourKey, u, "view");
    return this.tours.saveProgress(
      u.orgId,
      u.userId,
      tourKey,
      body.currentStep,
    );
  }

  @Post("tours/:tourKey/complete")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  @Validate({ params: tourKeyParams })
  async completeTour(
    @Param("tourKey") tourKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertTourAccess(tourKey, u, "view");
    return this.tours.completeTour(u.orgId, u.userId, tourKey);
  }

  @Post("tours/:tourKey/dismiss")
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  @Validate({ params: tourKeyParams })
  async dismissTour(
    @Param("tourKey") tourKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertTourAccess(tourKey, u, "view");
    return this.tours.dismissTour(u.orgId, u.userId, tourKey);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:manage")
  getProgress(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.getProgressSummary(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:manage")
  @Validate({ body: initiateSchema })
  async initiate(
    @Body() body: InitiateInput,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.onboarding.initiate(u.orgId, u.userId, body);
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
  @RequirePermission("hr:onboarding:manage")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.listTemplates(u.orgId);
  }

  @Get("templates/departments")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:manage")
  listTemplateDepartments(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.listTemplateDepartments(u.orgId);
  }

  @Post("templates")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:manage")
  @HttpCode(201)
  @Validate({ body: createTemplateSchema })
  createTemplate(
    @Body() body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.createTemplate(u.orgId, u.userId, body);
  }

  @Post("reminders")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:manage")
  @Idempotent("hr.onboarding.send-reminders")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:onboarding-reminders")
  @HttpCode(201)
  sendReminders(@CurrentUser() currentUser: CurrentUserContext) {
    return this.onboarding.sendReminders(currentUser.orgId);
  }

  @Patch("personal-details")
  @Universal()
  @Validate({ body: personalDetailsSchema })
  savePersonalDetails(
    @Body() body: PersonalDetailsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.savePersonalDetails(u.orgId, u.userId, body);
  }

  @Get("personal-details")
  @Universal()
  getPersonalDetails(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.getPersonalDetails(u.orgId, u.userId);
  }

  @Patch("bank-details")
  @Universal()
  @Validate({ body: bankDetailsSchema })
  saveBankDetails(
    @Body() body: BankDetailsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.saveBankDetails(u.orgId, u.userId, body);
  }

  @Get("bank-details")
  @Universal()
  getBankDetails(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.getBankDetails(u.orgId, u.userId);
  }

  @Post("submit")
  @Idempotent("hr.onboarding.submit")
  @Universal()
  submit(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.submit(u.orgId, u.userId);
  }

  @Patch("tasks/:taskId")
  @UseGuards(PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("self:onboarding-tasks")
  @Validate({ params: taskIdParams, body: updateTaskSchema })
  updateTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body() body: UpdateTaskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.updateTask(u, taskId, body);
  }

  @Get("status")
  @Universal()
  getStatus(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.getStatus(u.userId, u.orgId);
  }

  @Get("requirements")
  @Universal()
  @Validate({ query: requirementsQuerySchema })
  getRequirements(
    @Query() query: RequirementsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.requirements.getRequirements(u.orgId, query.country);
  }

  @Post("requirements/documents")
  @UseGuards(PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("hr:onboarding:manage")
  @HttpCode(200)
  @Validate({ body: ensureDocumentsSchema })
  ensureRequirementDocuments(
    @Body() body: EnsureDocumentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.requirements.ensureDocumentTypes(u.orgId, body.country);
  }

  @Get("me")
  @UseGuards(PermissionGuard)
  @RequireModule("hr")
  @RequirePermission("self:onboarding-tasks")
  getMyTasks(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.getUserTasks(u, u.userId);
  }

  @Get(":userId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:onboarding:tasks:view")
  @Validate({ params: userIdParams })
  getUserTasks(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.getUserTasks(u, userId);
  }
}
