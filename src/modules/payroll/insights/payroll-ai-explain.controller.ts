import {
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayrollAiExplainService } from "./payroll-ai-explain.service";

@Controller("payroll/me/payslips")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollAiExplainController {
  constructor(private readonly explainService: PayrollAiExplainService) {}

  @Post(":publicationId/ai/explain")
  @HttpCode(200)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("self:payslips")
  explainPayslip(
    @Param("publicationId", ParseIntPipe) publicationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.explainPayslip(u.orgId, u.userId, publicationId);
  }
}
