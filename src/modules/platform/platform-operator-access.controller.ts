import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import { Validate } from "../../common/validation/validate.decorator";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";
import {
  createGrantSchema,
  listGrantsQuerySchema,
  listLogsQuerySchema,
  revokeGrantSchema,
  type CreateGrantInput,
  type ListGrantsQuery,
  type ListLogsQuery,
  type RevokeGrantInput,
} from "./dto/platform.schemas";

function assertInternalSecret(secret: string | undefined): void {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected || secret !== expected) throw new UnauthorizedException("Invalid internal secret");
}

function ipOf(req: Request): string | undefined {
  return req.ip || undefined;
}

function humanOperatorId(user: CurrentUserContext): string {
  if (user.principal.kind !== "human-session")
    throw new UnauthorizedException("Operator administration requires a human session");
  if (!isEligibleOperator(user))
    throw new UnauthorizedException("Operator administration requires an eligible admin role");
  return user.userId;
}

function isEligibleOperator(user: CurrentUserContext): boolean {
  return user.isOrgOwner || ["ADMIN", "OWNER", "ORG_ADMIN"].includes(user.role);
}

@Controller("platform/operator-access")
export class PlatformOperatorAccessController {
  constructor(private readonly operatorAccess: PlatformOperatorAccessService) {}

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform admin only; creates a pending grant requiring a second approver",
  )
  @Post("grants")
  @Validate({ body: createGrantSchema })
  async createGrant(
    @Headers("x-internal-secret") secret: string | undefined,
    @Body() body: CreateGrantInput,
    @CurrentUser() user: CurrentUserContext,
    @Req() req: Request,
  ): Promise<{ grantId: string }> {
    assertInternalSecret(secret);
    const requesterId = humanOperatorId(user);
    const grantId = await this.operatorAccess.createGrant({
      operatorUserId: body.operatorUserId,
      orgId: body.orgId,
      incidentRef: body.incidentRef,
      grantedBy: requesterId,
      scope: body.scope,
      expiresAt: new Date(body.expiresAt),
    });
    await this.operatorAccess.recordAccess(
      grantId,
      body.operatorUserId,
      body.orgId,
      "grant.requested",
      ipOf(req),
      { incidentRef: body.incidentRef, scope: body.scope, requestedBy: requesterId },
    );
    return { grantId };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — approves a pending grant; approverId must differ from the original requester (grantedBy)",
  )
  @Post("grants/:grantId/approve")
  @HttpCode(200)
  @BodylessAction()
  async approveGrant(
    @Headers("x-internal-secret") secret: string | undefined,
    @Param("grantId") grantId: string,
    @CurrentUser() user: CurrentUserContext,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    assertInternalSecret(secret);
    const approverId = humanOperatorId(user);
    const { orgId, operatorUserId } = await this.operatorAccess.approveGrant(
      grantId,
      approverId,
    );
    await this.operatorAccess.recordAccess(
      grantId,
      approverId,
      orgId,
      "grant.approved",
      ipOf(req),
      { operatorUserId },
    );
    return { ok: true };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — rejects a pending grant; reason stored in revocation_reason",
  )
  @Post("grants/:grantId/reject")
  @HttpCode(200)
  @Validate({ body: revokeGrantSchema })
  async rejectGrant(
    @Headers("x-internal-secret") secret: string | undefined,
    @Param("grantId") grantId: string,
    @Body() body: RevokeGrantInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ ok: true }> {
    assertInternalSecret(secret);
    humanOperatorId(user);
    await this.operatorAccess.rejectGrant(grantId, body.reason);
    return { ok: true };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform admin only; lists grants for an org (default: active only)",
  )
  @Get("grants")
  @Validate({ query: listGrantsQuerySchema })
  async listGrants(
    @Headers("x-internal-secret") secret: string | undefined,
    @Query() query: ListGrantsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    assertInternalSecret(secret);
    humanOperatorId(user);
    return this.operatorAccess.listGrants(query.orgId, query.status);
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform admin only; revokes an active grant immediately",
  )
  @Delete("grants/:grantId")
  @HttpCode(200)
  @Validate({ body: revokeGrantSchema })
  async revokeGrant(
    @Headers("x-internal-secret") secret: string | undefined,
    @Param("grantId") grantId: string,
    @Body() body: RevokeGrantInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ ok: true }> {
    assertInternalSecret(secret);
    humanOperatorId(user);
    await this.operatorAccess.revokeGrant(grantId, body.reason);
    return { ok: true };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform admin only; lists access log for an org",
  )
  @Get("logs")
  @Validate({ query: listLogsQuerySchema })
  async listLogs(
    @Headers("x-internal-secret") secret: string | undefined,
    @Query() query: ListLogsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    assertInternalSecret(secret);
    humanOperatorId(user);
    return this.operatorAccess.listLogs(query.orgId, query.limit);
  }
}
