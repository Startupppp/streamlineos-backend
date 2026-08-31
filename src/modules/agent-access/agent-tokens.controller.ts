import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AgentTokensService } from "./agent-tokens.service";
import { createAgentTokenSchema, type CreateAgentTokenInput } from "./dto/agent-tokens.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const tokenIdParams = z.object({ tokenId: z.coerce.number().int().positive() }).strict();

@Controller("agent-tokens")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AgentTokensController {
  constructor(private readonly svc: AgentTokensService) {}

  @RequirePermission("settings:api-tokens:write")
  @Post()
  @HttpCode(201)
  @Validate({ body: createAgentTokenSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateAgentTokenInput,
  ) {
    return this.svc.create(u.userId, u.orgId, body);
  }

  @RequirePermission("settings:api-tokens:read")
  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.svc.list(u.userId, u.orgId);
  }

  @RequirePermission("settings:api-tokens:write")
  @Delete(":tokenId")
  @HttpCode(204)
  @Validate({ params: tokenIdParams })
  revoke(
    @CurrentUser() u: CurrentUserContext,
    @Param("tokenId", ParseIntPipe) tokenId: number,
  ) {
    return this.svc.revoke(u.userId, u.orgId, tokenId);
  }
}
