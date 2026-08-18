import { Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type {
  BankDetailsInput,
  CreateTemplateInput,
  InitiateInput,
  PersonalDetailsInput,
  UpdateTaskInput,
} from "./dto/onboarding.schemas";
import { OnboardingAdminService } from "./onboarding-admin.service";
import { OnboardingDetailsService } from "./onboarding-details.service";
import { OnboardingInitiationService } from "./onboarding-initiation.service";
import { OnboardingSubmissionService } from "./onboarding-submission.service";
import { OnboardingTaskService } from "./onboarding-task.service";
import { OnboardingTemplateService } from "./onboarding-template.service";

export {
  isInitiateAlreadyDone,
  isInitiateUserNotFound,
  type InitiateResult,
} from "./onboarding-initiation.service";

@Injectable()
export class OnboardingService {
  constructor(
    private readonly initiation: OnboardingInitiationService,
    private readonly submission: OnboardingSubmissionService,
    private readonly tasks: OnboardingTaskService,
    private readonly admin: OnboardingAdminService,
    private readonly details: OnboardingDetailsService,
    private readonly templates: OnboardingTemplateService,
  ) {}

  initiate(orgId: string, actorId: string, input: InitiateInput) {
    return this.initiation.initiate(orgId, actorId, input);
  }

  submit(orgId: string, userId: string) {
    return this.submission.submit(orgId, userId);
  }

  getProgressSummary(orgId: string) {
    return this.admin.getProgressSummary(orgId);
  }

  sendReminders(organizationId: string) {
    return this.admin.sendReminders(organizationId);
  }

  listTemplateDepartments(orgId: string) {
    return this.templates.listTemplateDepartments(orgId);
  }

  listTemplates(orgId: string) {
    return this.templates.listTemplates(orgId);
  }

  createTemplate(orgId: string, userId: string, input: CreateTemplateInput) {
    return this.templates.createTemplate(orgId, userId, input);
  }

  savePersonalDetails(orgId: string, userId: string, input: PersonalDetailsInput) {
    return this.details.savePersonalDetails(orgId, userId, input);
  }

  getPersonalDetails(orgId: string, userId: string) {
    return this.details.getPersonalDetails(orgId, userId);
  }

  saveBankDetails(orgId: string, userId: string, input: BankDetailsInput) {
    return this.details.saveBankDetails(orgId, userId, input);
  }

  getBankDetails(orgId: string, userId: string) {
    return this.details.getBankDetails(orgId, userId);
  }

  getStatus(userId: string, orgId: string) {
    return this.details.getStatus(userId, orgId);
  }

  getUserTasks(u: CurrentUserContext, userId: string) {
    return this.tasks.getUserTasks(u, userId);
  }

  updateTask(u: CurrentUserContext, taskId: number, input: UpdateTaskInput) {
    return this.tasks.updateTask(u, taskId, input);
  }
}
