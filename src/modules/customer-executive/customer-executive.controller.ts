import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CsHealthService } from "./cs-health.service";
import { CustomerExecutiveService } from "./customer-executive.service";
import {
  createSurveySchema,
  updateHealthConfigSchema,
  updateSurveySchema,
  type CreateSurveyInput,
  type UpdateHealthConfigInput,
  type UpdateSurveyInput,
} from "./dto/customer-executive.schemas";

@Controller("customer-executive")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class CustomerExecutiveController {
  constructor(
    private readonly health: CsHealthService,
    private readonly customerExecutive: CustomerExecutiveService,
  ) {}

  @Get("health")
  @CheckAbility("read", "crm:clients")
  getHealth(@CurrentUser() u: CurrentUserContext) {
    return this.health.getLatestHealthScores(u.orgId);
  }

  @Get("health/config")
  @CheckAbility("read", "crm:clients")
  getHealthConfig(@CurrentUser() u: CurrentUserContext) {
    return this.health.getOrgHealthConfig(u.orgId);
  }

  @Put("health/config")
  @CheckAbility("update", "crm:clients")
  updateHealthConfig(
    @Body(new ZodValidationPipe(updateHealthConfigSchema)) body: UpdateHealthConfigInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.health.upsertOrgHealthConfig(u.orgId, u.userId, body.weights, body.thresholds);
  }

  @Post("health/recompute")
  @CheckAbility("update", "crm:clients")
  async recomputeHealth(@CurrentUser() u: CurrentUserContext) {
    const results = await this.health.computeHealthForOrg(u.orgId);
    const total = results.length;
    const healthy = results.filter((r) => r.status === "healthy").length;
    const atRisk = results.filter((r) => r.status === "at_risk").length;
    const critical = results.filter((r) => r.status === "critical").length;
    const avgScore = total > 0 ? Math.round(results.reduce((sum, r) => sum + r.score, 0) / total) : 0;
    return { healthy, atRisk, critical, total, avgScore };
  }

  @Get("nps")
  @CheckAbility("read", "crm:clients")
  listSurveys(@CurrentUser() u: CurrentUserContext) {
    return this.customerExecutive.listSurveys(u.orgId);
  }

  @Post("nps")
  @CheckAbility("manage", "crm:clients")
  createSurvey(
    @Body(new ZodValidationPipe(createSurveySchema)) body: CreateSurveyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.customerExecutive.createSurvey(u.orgId, u.userId, body);
  }

  @Get("nps/stats")
  @CheckAbility("read", "crm:clients")
  getNpsStats(@CurrentUser() u: CurrentUserContext) {
    return this.customerExecutive.getSurveyStats(u.orgId);
  }

  @Get("nps/:surveyId")
  @CheckAbility("read", "crm:clients")
  async getSurvey(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.customerExecutive.getSurvey(u.orgId, surveyId);
    if (!result) throw new NotFoundException("Survey not found");
    return result;
  }

  @Patch("nps/:surveyId")
  @CheckAbility("manage", "crm:clients")
  async updateSurvey(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(updateSurveySchema)) body: UpdateSurveyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.customerExecutive.updateSurvey(u.orgId, surveyId, body);
    if (!updated) throw new NotFoundException("Survey not found");
    return updated;
  }

  @Delete("nps/:surveyId")
  @CheckAbility("manage", "crm:clients")
  async deleteSurvey(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.customerExecutive.deleteSurvey(u.orgId, surveyId);
    if (!result) throw new NotFoundException("Survey not found");
    return result;
  }

  @Get("sla")
  getSla(@CurrentUser() u: CurrentUserContext) {
    return this.customerExecutive.getSlaReport(u.orgId);
  }
}
