import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { Validate } from "../../../common/validation/validate.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { RecruitmentJobsService } from "./recruitment-jobs.service";
import { RecruitmentSourcingService } from "./recruitment-sourcing.service";
import {
  internalApplySchema,
  type InternalApplyInput,
} from "./dto/jobs.schemas";
import {
  createReferralSubmissionSchema,
  type CreateReferralSubmissionInput,
} from "./dto/sourcing.schemas";
import {
  candidateReferralRowSchema,
  candidateReferralWithRelationsSchema,
  internalJobSchema,
  jobApplicationSchema,
} from "./dto/recruitment-response.schemas";

const jobIdParams = z.object({ jobId: z.coerce.number().int().positive() }).strict();

@Controller("hr/recruitment/me")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentSelfController {
  constructor(
    private readonly jobs: RecruitmentJobsService,
    private readonly sourcing: RecruitmentSourcingService,
  ) {}

  @Get("job-openings")
  @ResponseSchema(z.array(internalJobSchema))
  @RequirePermission("self:job-openings")
  listJobOpenings(@CurrentUser() u: CurrentUserContext) {
    return this.jobs.listInternalJobs(u.orgId);
  }

  @Post("job-openings/:jobId/apply")
  @Idempotent("hr.recruitment.self-internal-apply")
  @HttpCode(201)
  @ResponseSchema(jobApplicationSchema)
  @RequirePermission("self:job-openings")
  @Validate({ params: jobIdParams, body: internalApplySchema })
  applyToJobOpening(
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body() body: InternalApplyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.jobs.internalApply(u.orgId, u.userId, jobId, body);
  }

  @Get("referrals")
  @ResponseSchema(z.array(candidateReferralWithRelationsSchema))
  @RequirePermission("self:referrals")
  listOwnReferrals(@CurrentUser() u: CurrentUserContext) {
    return this.sourcing.listReferrals(
      u.orgId,
      u.userId,
      false,
      actingMembershipId(u.principal),
    );
  }

  @Post("referrals")
  @Idempotent("hr.recruitment.self-referral-create")
  @HttpCode(201)
  @ResponseSchema(candidateReferralRowSchema)
  @RequirePermission("self:referrals")
  @Validate({ body: createReferralSubmissionSchema })
  createOwnReferral(
    @Body() body: CreateReferralSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createReferral(
      u.orgId,
      u.userId,
      body,
      actingMembershipId(u.principal),
    );
  }
}
