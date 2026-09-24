import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { IdentityService } from "./identity.service";
import { IDENTITY_STATUSES } from "./identity-policy";

const candidateIdParams = z.object({ candidateId: z.coerce.number().int().positive() }).strict();

/**
 * A vendor token and nothing else.
 *
 * There is deliberately no field for a PAN, an Aadhaar or any other document
 * number. The candidate's own session with the vendor produces the token; this
 * process never sees the number, so it cannot store or forward one even by
 * mistake — which is a stronger guarantee than a policy saying it should not.
 */
const verifySchema = z.object({ vendorToken: z.string().trim().min(1).max(4000) }).strict();
type VerifyInput = z.infer<typeof verifySchema>;

const identityViewSchema = z.object({
  candidateId: z.number().int(),
  status: z.enum(IDENTITY_STATUSES),
  reference: z.string().nullable(),
  last4: z.string().nullable(),
  verifiedAt: z.date().nullable(),
  requiredByAJob: z.boolean(),
  providerBlockedReason: z.string().nullable(),
});

@RequireModule("hr")
@Controller("hr/recruitment/candidates/:candidateId/identity")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Get()
  @ResponseSchema(identityViewSchema)
  @RequirePermission("hr:requisitions:view")
  @Validate({ params: candidateIdParams })
  read(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.identity.read(u.orgId, candidateId);
  }

  @Post("verify")
  @ResponseSchema(identityViewSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: candidateIdParams, body: verifySchema })
  verify(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: VerifyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.identity.verify(u.orgId, u.userId, candidateId, body.vendorToken);
  }
}
