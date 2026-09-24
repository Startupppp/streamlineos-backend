import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AuthorizedInService } from "../../../../common/auth/authorized-in-service.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { InternalMobilityService } from "./internal-mobility.service";
import {
  internalApprovalDecisionSchema,
  internalApprovalListSchema,
  internalApprovalResultSchema,
  internalMyApplicationListSchema,
  type InternalApprovalDecisionInput,
} from "./internal-mobility.schemas";

const applicationIdParams = z
  .object({ applicationId: z.coerce.number().int().positive() })
  .strict();

/**
 * The two internal-mobility surfaces that belong to a person rather than to a
 * recruiter: the applicant's own applications, and the decisions waiting on
 * their manager.
 *
 * `@AuthorizedInService` on all three, because the authority here is standing —
 * being the applicant, or being the head of that applicant's department —
 * rather than a permission key. Every one of them re-derives the caller's
 * membership from the session and puts it in the SQL predicate, so a key could
 * not widen them and its absence does not narrow them.
 *
 * A permission key would in fact be worse than useless: `hr:requisitions:view`
 * is held by recruiters, and hanging the manager queue off it would show every
 * recruiter every quiet internal move in the organisation.
 */
@RequireModule("hr")
@Controller("hr/recruitment/internal-mobility")
@UseGuards(JwtAuthGuard)
export class InternalMobilityController {
  constructor(private readonly mobility: InternalMobilityService) {}

  @Get("my-applications")
  @ResponseSchema(internalMyApplicationListSchema)
  @AuthorizedInService("InternalMobilityService.myApplications — matched on the caller's own login email")
  myApplications(@CurrentUser() u: CurrentUserContext) {
    return this.mobility.myApplications(u.orgId, u.userId);
  }

  @Get("approvals")
  @ResponseSchema(internalApprovalListSchema)
  @AuthorizedInService("InternalMobilityService.pendingApprovals — predicated on the caller's own membership as department head")
  async approvals(@CurrentUser() u: CurrentUserContext) {
    const membershipId = await this.mobility.membershipIdFor(u.orgId, u.userId);
    return this.mobility.pendingApprovals(u.orgId, membershipId);
  }

  @Post("approvals/:applicationId")
  @ResponseSchema(internalApprovalResultSchema)
  @AuthorizedInService("InternalMobilityService.decide — the update matches only rows whose manager is the caller")
  @Validate({ params: applicationIdParams, body: internalApprovalDecisionSchema })
  async decide(
    @Param("applicationId", ParseIntPipe) applicationId: number,
    @Body() body: InternalApprovalDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const membershipId = await this.mobility.membershipIdFor(u.orgId, u.userId);
    return this.mobility.decide(
      u.orgId,
      membershipId,
      u.userId,
      applicationId,
      body.decision,
      body.note ?? null,
    );
  }
}
