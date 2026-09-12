import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { HrBenefitsClaimsService } from "./hr-benefits-claims.service";
import {
  submitClaimSchema,
  reviewClaimSchema,
  setPayoutRouteSchema,
  claimsQuerySchema,
  type SubmitClaimInput,
  type ReviewClaimInput,
  type SetPayoutRouteInput,
  type ClaimsQuery,
} from "./dto/benefits.schemas";
import { AccessService } from "../../access/access.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { listClaimsResponseSchema, submitClaimResponseSchema, reviewClaimResponseSchema, setPayoutRouteResponseSchema } from "./dto/benefits-response.schemas";

const claimIdParams = z.object({ claimId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/benefits")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrBenefitsClaimsController {
  constructor(
    private readonly claims: HrBenefitsClaimsService,
    private readonly access: AccessService,
  ) {}

  private async isAdmin(u: CurrentUserContext) {
    if (u.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:benefits:manage");
  }

  @ResponseSchema(listClaimsResponseSchema)
  @Get("claims")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ query: claimsQuerySchema })
  async listClaims(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ClaimsQuery,
  ) {
    const isAdmin = await this.isAdmin(u);
    return this.claims.listClaims(u.orgId, query, u.userId, actingMembershipId(u.principal), isAdmin);
  }

  @ResponseSchema(submitClaimResponseSchema)
  @Post("claims")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:view")
  @Validate({ body: submitClaimSchema })
  submitClaim(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: SubmitClaimInput,
  ) {
    return this.claims.submitClaim(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @ResponseSchema(reviewClaimResponseSchema)
  @Patch("claims/:claimId/review")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  @Validate({ params: claimIdParams, body: reviewClaimSchema })
  reviewClaim(
    @CurrentUser() u: CurrentUserContext,
    @Param("claimId", ParseIntPipe) claimId: number,
    @Body() body: ReviewClaimInput,
  ) {
    return this.claims.reviewClaim(u.orgId, claimId, u.userId, actingMembershipId(u.principal), body);
  }

  @ResponseSchema(setPayoutRouteResponseSchema)
  @Patch("claims/:claimId/payout-route")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:benefits:manage")
  @Validate({ params: claimIdParams, body: setPayoutRouteSchema })
  setPayoutRoute(
    @CurrentUser() u: CurrentUserContext,
    @Param("claimId", ParseIntPipe) claimId: number,
    @Body() body: SetPayoutRouteInput,
  ) {
    return this.claims.setPayoutRoute(u.orgId, claimId, body.payoutRoute);
  }
}
