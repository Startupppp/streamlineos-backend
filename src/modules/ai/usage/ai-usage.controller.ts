import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AiUsageService } from "./ai-usage.service";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { aiUsageResponseSchema } from "../core/dto/ai-response.schemas";

@Controller("ai/usage")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AiUsageController {
  constructor(private readonly usage: AiUsageService) {}

  @Get()
  @RequirePermission("ai:usage:view")
  @ResponseSchema(aiUsageResponseSchema)
  getUsage(@CurrentUser() u: CurrentUserContext) {
    return this.usage.getOrgUsage(u);
  }
}
