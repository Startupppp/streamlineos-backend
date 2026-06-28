import { Controller, ForbiddenException, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentPipelineService } from "./recruitment-pipeline.service";
import { AccessService } from "../access/access.service";
import { diversityReportQuerySchema, type DiversityReportQueryInput } from "./dto/candidates.schemas";

@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard)
export class RecruitmentPipelineController {
  constructor(
    private readonly pipeline: RecruitmentPipelineService,
    private readonly access: AccessService,
  ) {}

  @Get("pipeline")
  getPipeline(@CurrentUser() u: CurrentUserContext) {
    return this.pipeline.pipeline(u.orgId);
  }

  @Get("diversity-report")
  diversityReport(
    @Query(new ZodValidationPipe(diversityReportQuerySchema)) query: DiversityReportQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pipeline.diversityReport(u.orgId, query);
  }

  @Get("bgv-compliance")
  async bgvCompliance(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.pipeline.bgvCompliance(u.orgId);
  }
}
