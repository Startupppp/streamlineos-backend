import {
  BadRequestException,
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
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { LeadsDetailService } from "./leads-detail.service";
import { LeadStatusService } from "./lead-status.service";
import {
  assignSchema,
  customDataSchema,
  leadMergeSchema,
  logActivitySchema,
  rejectSchema,
  transitionLeadStatusSchema,
  verifySchema,
  type AssignInput,
  type CustomDataInput,
  type LeadMergeInput,
  type LogActivityInput,
  type RejectInput,
  type TransitionLeadStatusInput,
  type VerifyInput,
} from "./dto/lead-mutations.schemas";

function resolveLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

@Controller("leads")
@UseGuards(JwtAuthGuard)
export class LeadsDetailController {
  constructor(
    private readonly detail: LeadsDetailService,
    private readonly status: LeadStatusService,
  ) {}

  @Get(":leadId/activities")
  getActivities(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Query("limit") limit: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.detail.getActivities(u.orgId, leadId, resolveLimit(limit, 20));
  }

  @Post(":leadId/activities")
  @HttpCode(201)
  addActivity(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Body(new ZodValidationPipe(logActivitySchema)) body: LogActivityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.detail.addActivity(u.orgId, u.userId, leadId, body);
  }

  @Get(":leadId/timeline")
  getTimeline(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Query("limit") limit: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.detail.getTimeline(u.orgId, leadId, resolveLimit(limit, 50));
  }

  @Get(":leadId/score-explanation")
  async getScoreExplanation(
    @Param("leadId", ParseIntPipe) leadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.detail.getScoreExplanation(u.orgId, leadId);
    if (!result) throw new NotFoundException("Lead not found");
    return result;
  }

  @Patch(":leadId/custom-data")
  async updateCustomData(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Body(new ZodValidationPipe(customDataSchema)) body: CustomDataInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.detail.updateCustomData(u.orgId, leadId, body);
    if (!result) throw new NotFoundException("Lead not found");
    return result;
  }

  @Patch(":leadId/status")
  async changeStatus(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Body(new ZodValidationPipe(transitionLeadStatusSchema)) body: TransitionLeadStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.status.changeStatus(u.orgId, u.userId, leadId, body);
    if (!result.ok) {
      if (result.reason === "already_converted") {
        throw new ConflictException("Lead has already been converted");
      }
      throw new ConflictException(
        "Lead status has been updated by someone else, or lead not found. Please refresh.",
      );
    }
    return result.lead;
  }

  @Patch(":leadId/verify")
  @UseGuards(AbilityGuard)
  @CheckAbility("update", "crm:leads")
  async verify(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Body(new ZodValidationPipe(verifySchema)) body: VerifyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.detail.verify(u.orgId, u.userId, leadId, body);
    if (!updated) throw new NotFoundException("Lead not found");
    return updated;
  }

  @Patch(":leadId/reject")
  @UseGuards(AbilityGuard)
  @CheckAbility("update", "crm:leads")
  async reject(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Body(new ZodValidationPipe(rejectSchema)) body: RejectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.detail.reject(u.orgId, u.userId, leadId, body);
    if (!updated) throw new NotFoundException("Lead not found");
    return updated;
  }

  @Patch(":leadId/self-assign")
  async selfAssign(
    @Param("leadId", ParseIntPipe) leadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.detail.selfAssign(u.orgId, u.userId, leadId);
    if (!updated) throw new NotFoundException("Lead not found");
    return updated;
  }

  @Patch(":leadId/assign")
  async assign(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.detail.assign(u.orgId, u.userId, leadId, body);
    if (!updated) throw new NotFoundException("Lead not found");
    return updated;
  }

  @Post(":leadId/merge")
  @HttpCode(200)
  async mergeLoser(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Body(new ZodValidationPipe(leadMergeSchema)) body: LeadMergeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.detail.mergeLoser(u.orgId, leadId, body.mergeLeadId);
    if (!result.ok) {
      if (result.reason === "self") {
        throw new BadRequestException("Cannot merge a lead with itself");
      }
      if (result.reason === "keep_not_found") {
        throw new NotFoundException("Lead not found");
      }
      throw new NotFoundException("Duplicate lead not found");
    }
    return { success: true };
  }
}
