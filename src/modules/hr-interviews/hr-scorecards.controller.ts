import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrScorecardsService } from "./hr-scorecards.service";
import { AccessService } from "../access/access.service";
import {
  createScorecardTemplateSchema,
  scorecardAnalyticsQuerySchema,
  updateScorecardTemplateSchema,
  type CreateScorecardTemplateInput,
  type ScorecardAnalyticsQueryInput,
  type UpdateScorecardTemplateInput,
} from "./dto/hr-interviews.schemas";

@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard)
export class HrScorecardsController {
  constructor(
    private readonly scorecards: HrScorecardsService,
    private readonly access: AccessService,
  ) {}

  @Get("scorecard-templates")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.scorecards.listTemplates(u.orgId);
  }

  @Post("scorecard-templates")
  @HttpCode(201)
  async createTemplate(
    @Body(new ZodValidationPipe(createScorecardTemplateSchema)) body: CreateScorecardTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.scorecards.createTemplate(u.orgId, u.userId, body);
  }

  @Patch("scorecard-templates/:templateId")
  async updateTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateScorecardTemplateSchema)) body: UpdateScorecardTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.scorecards.updateTemplate(u.orgId, templateId, body);
  }

  @Delete("scorecard-templates/:templateId")
  async deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.scorecards.deleteTemplate(u.orgId, templateId);
  }

  @Get("scorecard-analytics")
  analytics(
    @Query(new ZodValidationPipe(scorecardAnalyticsQuerySchema)) query: ScorecardAnalyticsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scorecards.analytics(u.orgId, query);
  }
}
