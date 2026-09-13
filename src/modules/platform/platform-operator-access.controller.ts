import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import type { Request } from "express";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { Validate } from "../../common/validation/validate.decorator";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { isPlatformAdmin } from "../../common/rbac/platform-operators";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";
import {
  createGrantSchema,
  listGrantsQuerySchema,
  listLogsQuerySchema,
  operatorAccessAckResponseSchema,
  operatorAccessGrantCreatedResponseSchema,
  operatorAccessGrantListResponseSchema,
  operatorAccessLogListResponseSchema,
  revokeGrantSchema,
  type CreateGrantInput,
  type ListGrantsQuery,
  type ListLogsQuery,
  type RevokeGrantInput,
} from "./dto/platform.schemas";

function assertInternalSecret(secret: string | undefined, expected: string | undefined): void {
  if (!expected || secret !== expected) throw new UnauthorizedException("Invalid internal secret");
}

function ipOf(req: Request): string | undefined {
  return req.ip || undefined;
}

function humanOperatorId(user: CurrentUserContext): string {
  if (user.principal.kind !== "human-session")
    throw new UnauthorizedException("Operator administration requires a human session");
  if (!isPlatformAdmin(user.userId))
    throw new UnauthorizedException("Operator administration requires a platform admin account");
  return user.userId;
}


/**
 * PRD-C048 — `grant_id` is a Postgres `uuid` (`db/schema/common/platform.ts:135`), so an
 * unvalidated path segment reached the comparison as raw text and failed `22P02` inside
 * the query rather than 400 at the boundary. Three handlers bound it with no pipe and no
 * `@Validate({ params })`.
 */
const grantIdParams = z.object({ grantId: z.string().uuid() }).strict();

@Controller("platform/operator-access")
export class PlatformOperatorAccessController {
  constructor(
    private readonly operatorAccess: PlatformOperatorAccessService,
    @Optional() @Inject(APP_CONFIG) private readonly config?: Pick<AppConfig, "INTERNAL_API_SECRET">,
  ) {}

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform admin only; creates a pending grant requiring a second approver",
  )
  @Post("grants")
  @Validate({ body: createGrantSchema })
  @ResponseSchema(operatorAccessGrantCreatedResponseSchema)
  async createGrant(
    @Headers("x-internal-secret") secret: string | undefined,
    @Body() body: CreateGrantInput,
    @CurrentUser() user: CurrentUserContext,
    @Req() req: Request,
  ): Promise<{ grantId: string }> {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    const requesterId = humanOperatorId(user);
    const grantId = await this.operatorAccess.createGrantAndLog(
      {
        operatorUserId: body.operatorUserId,
        orgId: body.orgId,
        incidentRef: body.incidentRef,
        reason: body.reason,
        grantedBy: requesterId,
        scope: body.scope,
        expiresAt: new Date(body.expiresAt),
      },
      ipOf(req),
      { incidentRef: body.incidentRef, reason: body.reason, scope: body.scope, requestedBy: requesterId },
    );
    return { grantId };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — approves a pending grant; approverId must differ from the original requester (grantedBy)",
  )
  @Post("grants/:grantId/approve")
  @HttpCode(200)
  @BodylessAction()
  @Validate({ params: grantIdParams })
  @ResponseSchema(operatorAccessAckResponseSchema)
  async approveGrant(
    @Headers("x-internal-secret") secret: string | undefined,
    @Param("grantId") grantId: string,
    @CurrentUser() user: CurrentUserContext,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    const approverId = humanOperatorId(user);
    await this.operatorAccess.approveGrant(
      grantId,
      approverId,
      ipOf(req),
    );
    return { ok: true };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — rejects a pending grant; reason stored in revocation_reason",
  )
  @Post("grants/:grantId/reject")
  @HttpCode(200)
  @Validate({ params: grantIdParams, body: revokeGrantSchema })
  @ResponseSchema(operatorAccessAckResponseSchema)
  async rejectGrant(
    @Headers("x-internal-secret") secret: string | undefined,
    @Param("grantId") grantId: string,
    @Body() body: RevokeGrantInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ ok: true }> {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    humanOperatorId(user);
    await this.operatorAccess.rejectGrant(grantId, body.reason, humanOperatorId(user), undefined);
    return { ok: true };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform admin only; lists grants for an org (default: active only)",
  )
  @Get("grants")
  @Validate({ query: listGrantsQuerySchema })
  @ResponseSchema(operatorAccessGrantListResponseSchema)
  async listGrants(
    @Headers("x-internal-secret") secret: string | undefined,
    @Query() query: ListGrantsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    humanOperatorId(user);
    return this.operatorAccess.listGrants(query.orgId, query.status);
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform admin only; revokes an active grant immediately",
  )
  @Delete("grants/:grantId")
  @HttpCode(200)
  @Validate({ params: grantIdParams, body: revokeGrantSchema })
  @ResponseSchema(operatorAccessAckResponseSchema)
  async revokeGrant(
    @Headers("x-internal-secret") secret: string | undefined,
    @Param("grantId") grantId: string,
    @Body() body: RevokeGrantInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<{ ok: true }> {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    humanOperatorId(user);
    await this.operatorAccess.revokeGrant(grantId, body.reason, humanOperatorId(user), undefined);
    return { ok: true };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform admin only; lists access log for an org",
  )
  @Get("logs")
  @Validate({ query: listLogsQuerySchema })
  @ResponseSchema(operatorAccessLogListResponseSchema)
  async listLogs(
    @Headers("x-internal-secret") secret: string | undefined,
    @Query() query: ListLogsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    humanOperatorId(user);
    return this.operatorAccess.listLogs(query.orgId, query.limit);
  }

}
