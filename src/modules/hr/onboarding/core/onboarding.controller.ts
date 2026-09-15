import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../../common/auth/universal.decorator";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { AccessService } from "../../../access/access.service";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../../common/auth/principal";
import { OnboardingSubmissionService } from "./onboarding-submission.service";
import { OnboardingDetailsService } from "./onboarding-details.service";
import { OnboardingTaskService } from "./onboarding-task.service";
import { OnboardingRequirementsService } from "./onboarding-requirements.service";
import {
  bankDetailsSchema,
  personalDetailsSchema,
  requirementsQuerySchema,
  updateTaskSchema,
  type BankDetailsInput,
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
import { BodylessAction, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import {
  onboardingFlowSessionSchema,
  moduleChecklistListSchema,
  moduleChecklistSchema,
  moduleChecklistRowSchema,
  checklistProgressSchema,
  guidedTourListSchema,
  tourProgressRowSchema,
  personalDetailsResponseSchema,
  bankDetailsResponseSchema,
  onboardingStatusSchema,
  countryRequirementsSchema,
  onboardingTaskListSchema,
  onboardingCompletionSchema,
  successSchema,
} from "./dto/onboarding-response.schemas";

const moduleKeyParams = z.object({ moduleKey: z.string().min(1) }).strict();
const moduleKeyitemKeyParams = z
  .object({ moduleKey: z.string().min(1), itemKey: z.string().min(1) })
  .strict();
const tourKeyParams = z.object({ tourKey: z.string().min(1) }).strict();
const taskIdParams = z
  .object({ taskId: z.coerce.number().int().positive() })
  .strict();

const HR_MODULE_KEY: ModuleKey = "hr";

@Controller("onboarding")
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(
    private readonly submission: OnboardingSubmissionService,
    private readonly details: OnboardingDetailsService,
    private readonly tasks: OnboardingTaskService,
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
  @ResponseSchema(onboardingFlowSessionSchema)
  @Universal()
  getOnboardingSession(@CurrentUser() u: CurrentUserContext) {
    return this.sessions.getOrCreateSession(
      u.orgId,
      u.userId,
      "employee_onboarding",
      actingMembershipId(u.principal),
    );
  }

  @Patch("session")
  @ResponseSchema(onboardingFlowSessionSchema)
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
      actingMembershipId(u.principal),
    );
  }

  @Get("module-checklists")
  @ResponseSchema(moduleChecklistListSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:view")
  async listModuleChecklists(@CurrentUser() u: CurrentUserContext) {
    const includeHr = await this.hasHrChecklistAccess(u);
    return this.checklists.listChecklists(u.orgId, includeHr);
  }

  @Get("module-checklists/:moduleKey")
  @ResponseSchema(moduleChecklistSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:view")
  @Validate({ params: moduleKeyParams })
  async getModuleChecklist(
    @Param("moduleKey") moduleKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.isHrModuleKey(moduleKey))
      await this.assertHrChecklistAccess(u, "view");
    return this.checklists.getChecklist(u.orgId, moduleKey);
  }

  @Post("module-checklists/:moduleKey/items/:itemKey/complete")
  @ResponseSchema(checklistProgressSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  @Validate({ params: moduleKeyitemKeyParams })
  async completeChecklistItem(
    @Param("moduleKey") moduleKey: string,
    @Param("itemKey") itemKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.isHrModuleKey(moduleKey))
      await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.completeItem(u.orgId, moduleKey, itemKey, u.userId);
  }

  @Post("module-checklists/:moduleKey/items/:itemKey/skip")
  @ResponseSchema(checklistProgressSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  @Validate({ params: moduleKeyitemKeyParams, body: checklistItemSkipSchema })
  async skipChecklistItem(
    @Param("moduleKey") moduleKey: string,
    @Param("itemKey") itemKey: string,
    @Body() body: ChecklistItemSkipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.isHrModuleKey(moduleKey))
      await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.skipItem(
      u.orgId,
      moduleKey,
      itemKey,
      u.userId,
      body.reason,
    );
  }

  @Post("module-checklists/:moduleKey/dismiss")
  @ResponseSchema(moduleChecklistRowSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  @Validate({ params: moduleKeyParams })
  async dismissModuleChecklist(
    @Param("moduleKey") moduleKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.isHrModuleKey(moduleKey))
      await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.dismissChecklist(u.orgId, moduleKey, u.userId);
  }

  @Post("module-checklists/:moduleKey/restart")
  @ResponseSchema(checklistProgressSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:module-checklists:manage")
  @Validate({ params: moduleKeyParams })
  async restartModuleChecklist(
    @Param("moduleKey") moduleKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (this.isHrModuleKey(moduleKey))
      await this.assertHrChecklistAccess(u, "manage");
    return this.checklists.restartChecklist(u.orgId, moduleKey, u.userId);
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
  @ResponseSchema(guidedTourListSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  async listTours(@CurrentUser() u: CurrentUserContext) {
    const tours = await this.tours.listToursForUser(
      u.orgId,
      u.userId,
      u.role,
      actingMembershipId(u.principal),
    );
    const includeHr = await this.hasHrChecklistAccess(u);
    return includeHr
      ? tours
      : tours.filter((t) => t.tourKey !== HR_SETUP_TOUR_KEY);
  }

  @Post("tours/:tourKey/progress")
  @ResponseSchema(tourProgressRowSchema)
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
      actingMembershipId(u.principal),
    );
  }

  @Post("tours/:tourKey/complete")
  @ResponseSchema(tourProgressRowSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  @Validate({ params: tourKeyParams })
  async completeTour(
    @Param("tourKey") tourKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertTourAccess(tourKey, u, "view");
    return this.tours.completeTour(
      u.orgId,
      u.userId,
      tourKey,
      actingMembershipId(u.principal),
    );
  }

  @Post("tours/:tourKey/dismiss")
  @ResponseSchema(tourProgressRowSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("onboarding:tours:view")
  @Validate({ params: tourKeyParams })
  async dismissTour(
    @Param("tourKey") tourKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertTourAccess(tourKey, u, "view");
    return this.tours.dismissTour(
      u.orgId,
      u.userId,
      tourKey,
      actingMembershipId(u.principal),
    );
  }

  @Patch("personal-details")
  @ResponseSchema(successSchema)
  @Universal()
  @Validate({ body: personalDetailsSchema })
  savePersonalDetails(
    @Body() body: PersonalDetailsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.details.savePersonalDetails(u.orgId, u.userId, body);
  }

  @Get("personal-details")
  @ResponseSchema(personalDetailsResponseSchema)
  @Universal()
  getPersonalDetails(@CurrentUser() u: CurrentUserContext) {
    return this.details.getPersonalDetails(u.orgId, u.userId);
  }

  @Patch("bank-details")
  @ResponseSchema(successSchema)
  @Universal()
  @Validate({ body: bankDetailsSchema })
  saveBankDetails(
    @Body() body: BankDetailsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.details.saveBankDetails(u.orgId, u.userId, body);
  }

  @Get("bank-details")
  @ResponseSchema(bankDetailsResponseSchema)
  @Universal()
  getBankDetails(@CurrentUser() u: CurrentUserContext) {
    return this.details.getBankDetails(u.orgId, u.userId);
  }

  @Post("complete")
  @ResponseSchema(onboardingCompletionSchema)
  @BodylessAction()
  @Idempotent("hr.onboarding.complete")
  @Universal()
  complete(@CurrentUser() u: CurrentUserContext) {
    return this.submission.complete(u.orgId, u.userId);
  }

  @Patch("tasks/:taskId")
  @ResponseSchema(successSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("self:onboarding-tasks")
  @Validate({ params: taskIdParams, body: updateTaskSchema })
  updateTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body() body: UpdateTaskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.updateTask(u, taskId, body);
  }

  @Get("status")
  @ResponseSchema(onboardingStatusSchema)
  @Universal()
  getStatus(@CurrentUser() u: CurrentUserContext) {
    return this.details.getStatus(u.userId, u.orgId);
  }

  @Get("requirements")
  @ResponseSchema(countryRequirementsSchema)
  @Universal()
  @Validate({ query: requirementsQuerySchema })
  getRequirements(
    @Query() query: RequirementsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.requirements.getRequirements(u.orgId, query.country);
  }

  @Get("me")
  @ResponseSchema(onboardingTaskListSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("self:onboarding-tasks")
  getMyTasks(@CurrentUser() u: CurrentUserContext) {
    return this.tasks.getUserTasks(u, u.userId);
  }
}
