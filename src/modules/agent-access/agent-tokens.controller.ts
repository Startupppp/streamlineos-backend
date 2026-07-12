import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AgentTokensService } from "./agent-tokens.service";
import { createAgentTokenSchema, type CreateAgentTokenInput } from "./dto/agent-tokens.schemas";

@Controller("agent-tokens")
@UseGuards(JwtAuthGuard)
export class AgentTokensController {
  constructor(private readonly svc: AgentTokensService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createAgentTokenSchema)) body: CreateAgentTokenInput,
  ) {
    return this.svc.create(u.userId, u.orgId, body);
  }

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.svc.list(u.userId, u.orgId);
  }

  @Delete(":tokenId")
  @HttpCode(204)
  revoke(
    @CurrentUser() u: CurrentUserContext,
    @Param("tokenId", ParseIntPipe) tokenId: number,
  ) {
    return this.svc.revoke(u.userId, u.orgId, tokenId);
  }
}
