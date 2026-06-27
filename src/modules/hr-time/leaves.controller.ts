import {
  BadRequestException,
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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { LeavesService } from "./leaves.service";
import { LeavesWriteService } from "./leaves-write.service";
import { LeavesPageService } from "./leaves-page.service";
import {
  compOffSchema,
  createLeaveSchema,
  leaveAnalyticsQuerySchema,
  leaveCalendarQuerySchema,
  updateLeaveSchema,
  type CompOffInput,
  type CreateLeaveInput,
  type LeaveAnalyticsQuery,
  type LeaveCalendarQuery,
  type UpdateLeaveInput,
} from "./dto/leaves.schemas";

@Controller("hr/leaves")
@UseGuards(JwtAuthGuard)
export class LeavesController {
  constructor(
    private readonly leaves: LeavesService,
    private readonly leavesWrite: LeavesWriteService,
    private readonly leavesPage: LeavesPageService,
  ) {}

  @Get()
  pageData(@CurrentUser() u: CurrentUserContext) {
    return this.leavesPage.pageData(u.orgId, u.userId);
  }

  @Get("balance")
  balance(@CurrentUser() u: CurrentUserContext) {
    return this.leaves.balance(u.orgId, u.userId);
  }

  @Get("my")
  my(@CurrentUser() u: CurrentUserContext) {
    return this.leaves.my(u.orgId, u.userId);
  }

  @Get("team")
  team(@CurrentUser() u: CurrentUserContext) {
    return this.leaves.team(u);
  }

  @Get("this-week")
  thisWeek(@CurrentUser() u: CurrentUserContext) {
    return this.leaves.thisWeek(u.orgId);
  }

  @Get("analytics")
  analytics(
    @Query(new ZodValidationPipe(leaveAnalyticsQuerySchema)) query: LeaveAnalyticsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leaves.analytics(u, query.year ?? new Date().getFullYear());
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createLeaveSchema)) body: CreateLeaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leavesWrite.create(u, body);
  }

  @Post("comp-off")
  @HttpCode(201)
  compOff(
    @Body(new ZodValidationPipe(compOffSchema)) body: CompOffInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leaves.compOff(u, body);
  }

  @Patch(":leaveId/cancel")
  async cancel(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.leavesWrite.cancel(u, leaveId);
    if (!result.ok) throw new NotFoundException("Leave request not found.");
    return { success: true };
  }

  @Patch(":leaveId")
  async update(
    @Param("leaveId", ParseIntPipe) leaveId: number,
    @Body(new ZodValidationPipe(updateLeaveSchema)) body: UpdateLeaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.leavesWrite.updateStatus(u, leaveId, body);
    if (!result.ok) throw new NotFoundException("Leave request not found.");
    return { success: true };
  }
}

@Controller("hr/leave-calendar")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class LeaveCalendarController {
  constructor(private readonly leaves: LeavesService) {}

  @Get()
  @CheckAbility("read", "hr:leaves")
  calendar(
    @Query(new ZodValidationPipe(leaveCalendarQuerySchema)) query: LeaveCalendarQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const now = new Date();
    const month = query.month ?? now.getMonth() + 1;
    const year = query.year ?? now.getFullYear();
    if (month < 1 || month > 12) {
      throw new BadRequestException("month must be between 1 and 12");
    }
    return this.leaves.calendar(u.orgId, month, year);
  }
}
