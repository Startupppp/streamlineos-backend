import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { OnboardingInitiationService, isInitiateAlreadyDone, isInitiateUserNotFound } from "./onboarding-initiation.service";
import { OnboardingAdminService } from "./onboarding-admin.service";
import { OnboardingTaskService } from "./onboarding-task.service";
import { OnboardingTemplateService } from "./onboarding-template.service";
import { OnboardingRequirementsService } from "./onboarding-requirements.service";
import {
  createTemplateSchema,
  ensureDocumentsSchema,
  initiateSchema,
  type CreateTemplateInput,
  type EnsureDocumentsInput,
  type InitiateInput,
} from "./dto/onboarding.schemas";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { Validate } from "../../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { z } from "zod";
import {
  onboardingProgressListSchema,
  onboardingInitiateResponseSchema,
  onboardingTemplateListSchema,
  onboardingTemplateDepartmentListSchema,
  createTemplateResponseSchema,
  onboardingReminderResponseSchema,
  ensureDocumentTypesResponseSchema,
  onboardingTaskListSchema,
} from "./dto/onboarding-response.schemas";

const userIdParams = z.object({ userId: z.string().min(1) }).strict();

@RequireModule("hr")
@Controller("onboarding")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrOnboardingAdminController {
  constructor(
    private readonly initiation: OnboardingInitiationService,
    private readonly admin: OnboardingAdminService,
    private readonly tasks: OnboardingTaskService,
    private readonly templates: OnboardingTemplateService,
    private readonly requirements: OnboardingRequirementsService,
  ) {}

  @Get()
  @ResponseSchema(onboardingProgressListSchema)
  @RequirePermission("hr:onboarding:manage")
  getProgress(@CurrentUser() u: CurrentUserContext) {
    return this.admin.getProgressSummary(u.orgId);
  }

  @Post()
  @ResponseSchema(onboardingInitiateResponseSchema)
  @RequirePermission("hr:onboarding:manage")
  @Validate({ body: initiateSchema })
  async initiate(
    @Body() body: InitiateInput,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.initiation.initiate(u.orgId, u.userId, body);
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
  @ResponseSchema(onboardingTemplateListSchema)
  @RequirePermission("hr:onboarding:manage")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.templates.listTemplates(u.orgId);
  }

  @Get("templates/departments")
  @ResponseSchema(onboardingTemplateDepartmentListSchema)
  @RequirePermission("hr:onboarding:manage")
  listTemplateDepartments(@CurrentUser() u: CurrentUserContext) {
    return this.templates.listTemplateDepartments(u.orgId);
  }

  @Post("templates")
  @ResponseSchema(createTemplateResponseSchema)
  @RequirePermission("hr:onboarding:manage")
  @HttpCode(201)
  @Validate({ body: createTemplateSchema })
  createTemplate(
    @Body() body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.createTemplate(u.orgId, u.userId, body);
  }

  @Post("reminders")
  @ResponseSchema(onboardingReminderResponseSchema)
  @BodylessAction()
  @RequirePermission("hr:onboarding:manage")
  @Idempotent("hr.onboarding.send-reminders")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:onboarding-reminders")
  @HttpCode(201)
  sendReminders(@CurrentUser() currentUser: CurrentUserContext) {
    return this.admin.sendReminders(currentUser.orgId);
  }

  @Post("requirements/documents")
  @ResponseSchema(ensureDocumentTypesResponseSchema)
  @RequirePermission("hr:onboarding:manage")
  @HttpCode(200)
  @Validate({ body: ensureDocumentsSchema })
  ensureRequirementDocuments(
    @Body() body: EnsureDocumentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.requirements.ensureDocumentTypes(u.orgId, body.country);
  }

  @Get(":userId")
  @ResponseSchema(onboardingTaskListSchema)
  @RequirePermission("hr:onboarding:tasks:view")
  @Validate({ params: userIdParams })
  getUserTasks(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.getUserTasks(u, userId);
  }
}
