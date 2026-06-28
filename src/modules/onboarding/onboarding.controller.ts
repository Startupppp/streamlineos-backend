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
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
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
    const protocol = req.headers["x-forwarded-proto"] ?? req.protocol ?? "http";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000";
    const appUrl = `${String(protocol)}://${String(host)}`;
    return this.onboarding.sendReminders(u.orgId, appUrl);
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
