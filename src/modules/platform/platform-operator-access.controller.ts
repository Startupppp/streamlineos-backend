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
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";
import {
  approveGrantSchema,
  createGrantSchema,
  listGrantsQuerySchema,
  listLogsQuerySchema,
  revokeGrantSchema,
  type ApproveGrantInput,
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
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return raw?.split(",")[0]?.trim() ?? req.ip ?? undefined;
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
    @Req() req: Request,
  ): Promise<{ grantId: string }> {
    assertInternalSecret(secret);
    const grantId = await this.operatorAccess.createGrant({
      operatorUserId: body.operatorUserId,
      orgId: body.orgId,
      incidentRef: body.incidentRef,
      grantedBy: body.grantedBy,
      scope: body.scope,
      expiresAt: new Date(body.expiresAt),
    });
    await this.operatorAccess.recordAccess(
      grantId,
      body.operatorUserId,
      body.orgId,
      "grant.requested",
      ipOf(req),
      { incidentRef: body.incidentRef, scope: body.scope, requestedBy: body.grantedBy },
    );
    return { grantId };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — approves a pending grant; approverId must differ from the original requester (grantedBy)",
  )
  @Post("grants/:grantId/approve")
  @HttpCode(200)
  @Validate({ body: approveGrantSchema })
  async approveGrant(
    @Headers("x-internal-secret") secret: string | undefined,
    @Param("grantId") grantId: string,
    @Body() body: ApproveGrantInput,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    assertInternalSecret(secret);
    const { orgId, operatorUserId } = await this.operatorAccess.approveGrant(
      grantId,
      body.approverId,
    );
    await this.operatorAccess.recordAccess(
      grantId,
      body.approverId,
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
  ): Promise<{ ok: true }> {
    assertInternalSecret(secret);
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
  ) {
    assertInternalSecret(secret);
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
  ): Promise<{ ok: true }> {
    assertInternalSecret(secret);
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
  ) {
    assertInternalSecret(secret);
    return this.operatorAccess.listLogs(query.orgId, query.limit);
  }
}
