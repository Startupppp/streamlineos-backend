import { BadRequestException, Body, Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccountingAiService } from "./accounting-ai.service";
import {
  extractDocumentSchema,
  reconciliationExplainSchema,
  varianceExplainSchema,
} from "./dto/accounting-ai.dto";

@RequireModule("accounting")
@Controller("finance/ai")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class AccountingAiController {
  constructor(private readonly accountingAiService: AccountingAiService) {}

  @Post("variance-explain")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("accounting:reports:read")
  @UseRateLimit("ai:invoke")
  explainVariance(
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsed = varianceExplainSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.accountingAiService.explainVariance(u.orgId, u.userId, parsed.data);
  }

  @Post("reconciliation-explain")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("accounting:reports:read")
  @UseRateLimit("ai:invoke")
  explainReconciliation(
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsed = reconciliationExplainSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.accountingAiService.explainReconciliation(u.orgId, u.userId, parsed.data);
  }

  @Post("extract-document")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("accounting:payables:read")
  @UseRateLimit("ai:invoke")
  extractDocument(
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsed = extractDocumentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.accountingAiService.extractDocument(u.orgId, u.userId, parsed.data);
  }
}
