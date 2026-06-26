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
import { RECRUITMENT_ADMIN_ROLES } from "./recruitment-roles";
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
  constructor(private readonly scorecards: HrScorecardsService) {}

  @Get("scorecard-templates")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.scorecards.listTemplates(u.orgId);
  }

  @Post("scorecard-templates")
  @HttpCode(201)
  createTemplate(
    @Body(new ZodValidationPipe(createScorecardTemplateSchema)) body: CreateScorecardTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) {
      throw new ForbiddenException("Forbidden");
    }
    return this.scorecards.createTemplate(u.orgId, u.userId, body);
  }

  @Patch("scorecard-templates/:templateId")
  updateTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateScorecardTemplateSchema)) body: UpdateScorecardTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) {
      throw new ForbiddenException("Forbidden");
    }
    return this.scorecards.updateTemplate(u.orgId, templateId, body);
  }

  @Delete("scorecard-templates/:templateId")
  deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) {
      throw new ForbiddenException("Forbidden");
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
