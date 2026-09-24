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
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  pipelineResponseSchema,
  diversityReportSchema,
  bgvComplianceItemSchema,
} from "./dto/recruitment-response.schemas";

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentPipelineController {
  constructor(private readonly pipeline: RecruitmentPipelineService) {}

  @Get("pipeline")
  @ResponseSchema(pipelineResponseSchema)
  @RequirePermission("hr:requisitions:view")
  getPipeline(@CurrentUser() u: CurrentUserContext) {
    return this.pipeline.pipeline(u.orgId);
  }

  /**
   * `hr:sensitive:view`, not `hr:requisitions:view`.
   *
   * The report groups `candidates.gender` — a protected characteristic — so
   * anyone who could open a requisition could read an org-wide demographic
   * breakdown. The sibling `bgv-compliance` read already carries the sensitive
   * key and the frontend hook always asked for it; the route was the half that
   * was wrong, and relaxing the hook to match would have been papering over a
   * real disclosure from the client.
   */
  @Get("diversity-report")
  @ResponseSchema(diversityReportSchema)
  @RequirePermission("hr:sensitive:view")
  @Validate({ query: diversityReportQuerySchema })
  diversityReport(
    @Query() query: DiversityReportQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pipeline.diversityReport(u.orgId, query);
  }

  @Get("bgv-compliance")
  @ResponseSchema(z.array(bgvComplianceItemSchema))
  @RequirePermission("hr:sensitive:view")
  bgvCompliance(@CurrentUser() u: CurrentUserContext) {
    return this.pipeline.bgvCompliance(u.orgId);
  }
}
