import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RecruitmentPipelineService } from "./recruitment-pipeline.service";
import { diversityReportQuerySchema, type DiversityReportQueryInput } from "./dto/candidates.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentPipelineController {
  constructor(private readonly pipeline: RecruitmentPipelineService) {}

  @Get("pipeline")
  @RequirePermission("hr:employees:view")
  getPipeline(@CurrentUser() u: CurrentUserContext) {
    return this.pipeline.pipeline(u.orgId);
  }

  @Get("diversity-report")
  @RequirePermission("hr:employees:view")
  @Validate({ query: diversityReportQuerySchema })
  diversityReport(
    @Query() query: DiversityReportQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pipeline.diversityReport(u.orgId, query);
  }

  @Get("bgv-compliance")
  @RequirePermission("hr:sensitive:view")
  bgvCompliance(@CurrentUser() u: CurrentUserContext) {
    return this.pipeline.bgvCompliance(u.orgId);
  }
}
