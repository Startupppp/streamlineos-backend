import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
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

@Controller("onboarding")
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "settings:onboarding")
  getProgress(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.getProgressSummary(u.orgId);
  }

  @Post()
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "settings:onboarding")
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
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "settings:onboarding")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.listTemplates(u.orgId);
  }

  @Post("templates")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "settings:onboarding")
  @HttpCode(201)
  createTemplate(
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.createTemplate(u.orgId, u.userId, body);
  }

  @Patch("personal-details")
  savePersonalDetails(
    @Body(new ZodValidationPipe(personalDetailsSchema)) body: PersonalDetailsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.savePersonalDetails(u.orgId, u.userId, body);
  }

  @Patch("bank-details")
  saveBankDetails(
    @Body(new ZodValidationPipe(bankDetailsSchema)) body: BankDetailsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.saveBankDetails(u.orgId, u.userId, body);
  }

  @Post("submit")
  submit(@CurrentUser() u: CurrentUserContext) {
    return this.onboarding.submit(u.orgId, u.userId);
  }

  @Patch("tasks/:taskId")
  updateTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body(new ZodValidationPipe(updateTaskSchema)) body: UpdateTaskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.updateTask(u, taskId, body);
  }

  @Get(":userId")
  getUserTasks(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.onboarding.getUserTasks(u, userId);
  }
}
