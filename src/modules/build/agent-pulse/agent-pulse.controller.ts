import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { AgentPulseService } from "./agent-pulse.service";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  agentPulseBadgeSchema,
  agentPulseQuerySchema,
  agentPulseResponseSchema,
  applyDraftParamsSchema,
  applyDraftResponseSchema,
  type AgentPulseQuery,
} from "./dto/agent-pulse.schema";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("build")
@Controller("build/agent-pulse")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AgentPulseController {
  constructor(private readonly svc: AgentPulseService) {}

  @Get("top-signal")
  @RequirePermission("build:approvals:view")
  @ResponseSchema(agentPulseResponseSchema)
  @Validate({ query: agentPulseQuerySchema })
  getTopSignal(@CurrentUser() u: CurrentUserContext, @Query() query: AgentPulseQuery) {
    const mid = actingMembershipId(u.principal);
    return this.svc.getTopSignal(u.orgId, u.userId, mid, query);
  }

  @Get("badge")
  @RequirePermission("build:approvals:view")
  @ResponseSchema(agentPulseBadgeSchema)
  async badge(@CurrentUser() u: CurrentUserContext) {
    const pending = await this.svc.countPendingSignals(u.orgId, actingMembershipId(u.principal));
    return { pending };
  }

  @Post("proposals/:draftId/apply")
  @HttpCode(200)
  @RequirePermission("build:tickets:update")
  @ResponseSchema(applyDraftResponseSchema)
  @Validate({ params: applyDraftParamsSchema })
  @BodylessAction()
  applyDraft(@Param("draftId", ParseIntPipe) draftId: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.applyDraft(u.orgId, u.userId, actingMembershipId(u.principal), draftId);
  }
}
