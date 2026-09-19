import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { AgentPulseService } from "./agent-pulse.service";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { agentPulseResponseSchema } from "./dto/agent-pulse.schema";

@RequireModule("build")
@Controller("build/agent-pulse")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AgentPulseController {
  constructor(private readonly svc: AgentPulseService) {}

  @Get("top-signal")
  @RequirePermission("build:approvals:view")
  @ResponseSchema(agentPulseResponseSchema)
  getTopSignal(@CurrentUser() u: CurrentUserContext) {
    const mid = actingMembershipId(u.principal);
    return this.svc.getTopSignal(u.orgId, u.userId, mid);
  }
}
