import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccountingAiService } from "./accounting-ai.service";
import {
  extractDocumentSchema,
  reconciliationExplainSchema,
  varianceExplainSchema,
  type ExtractDocumentInput,
  type ReconciliationExplainInput,
  type VarianceExplainInput,
} from "./dto/accounting-ai.dto";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("accounting")
@Controller("finance/ai")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class AccountingAiController {
  constructor(private readonly accountingAiService: AccountingAiService) {}

  @Post("variance-explain")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("accounting:ai:use")
  @UseRateLimit("ai:invoke")
  @Validate({ body: varianceExplainSchema })
  explainVariance(
    @Body() body: VarianceExplainInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accountingAiService.explainVariance(u.orgId, u.userId, body);
  }

  @Post("reconciliation-explain")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("accounting:ai:use")
  @UseRateLimit("ai:invoke")
  @Validate({ body: reconciliationExplainSchema })
  explainReconciliation(
    @Body() body: ReconciliationExplainInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accountingAiService.explainReconciliation(u.orgId, u.userId, body);
  }

  @Post("extract-document")
  @UseGuards(PermissionGuard, RateLimitGuard)
  @RequirePermission("accounting:ai:use")
  @UseRateLimit("ai:invoke")
  @Validate({ body: extractDocumentSchema })
  extractDocument(
    @Body() body: ExtractDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.accountingAiService.extractDocument(u.orgId, u.userId, body);
  }
}
