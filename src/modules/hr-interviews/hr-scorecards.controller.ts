import {
  Body,
  Controller,
  Delete,
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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrScorecardsService } from "./hr-scorecards.service";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import {
  createScorecardTemplateSchema,
  scorecardAnalyticsQuerySchema,
  updateScorecardTemplateSchema,
  type CreateScorecardTemplateInput,
  type ScorecardAnalyticsQueryInput,
  type UpdateScorecardTemplateInput,
} from "./dto/hr-interviews.schemas";

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrScorecardsController {
  constructor(private readonly scorecards: HrScorecardsService) {}

  @Get("scorecard-templates")
  @RequirePermission("hr:interviews:view")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.scorecards.listTemplates(u.orgId);
  }

  @Post("scorecard-templates")
  @HttpCode(201)
  @RequirePermission("hr:interviews:manage")
  createTemplate(
    @Body(new ZodValidationPipe(createScorecardTemplateSchema)) body: CreateScorecardTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scorecards.createTemplate(u.orgId, u.userId, body);
  }

  @Patch("scorecard-templates/:templateId")
  @RequirePermission("hr:interviews:manage")
  updateTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateScorecardTemplateSchema)) body: UpdateScorecardTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scorecards.updateTemplate(u.orgId, templateId, body);
  }

  @Delete("scorecard-templates/:templateId")
  @RequirePermission("hr:interviews:manage")
  deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scorecards.deleteTemplate(u.orgId, templateId);
  }

  @Get("scorecard-analytics")
  @RequirePermission("hr:interviews:view")
  analytics(
    @Query(new ZodValidationPipe(scorecardAnalyticsQuerySchema)) query: ScorecardAnalyticsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scorecards.analytics(u.orgId, query);
  }
}
