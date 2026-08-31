import { Module } from "@nestjs/common";
import { AccountingPostingModule } from "../../accounting/posting/accounting-posting.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { ApprovalPoliciesController } from "./approval-policies.controller";
import { FinanceApprovalsController } from "./approvals.controller";
import { FinanceAuditController } from "./audit.controller";
import { ExchangeRatesController } from "./exchange-rates.controller";
import { ApprovalPoliciesService } from "./approval-policies.service";
import { ApprovalsService } from "./approvals.service";
import { AuditSurfaceService } from "./audit-surface.service";
import { ExchangeRatesService } from "./exchange-rates.service";
import { RateResolverService } from "./rate-resolver.service";
import { FxService } from "./fx.service";
import { ProviderBridgeService } from "./provider-bridge.service";

@Module({
  imports: [AccountingPostingModule, NotificationsModule],
  controllers: [
    ApprovalPoliciesController,
    FinanceApprovalsController,
    FinanceAuditController,
    ExchangeRatesController,
  ],
  providers: [
    ApprovalPoliciesService,
    ApprovalsService,
    AuditSurfaceService,
    ExchangeRatesService,
    RateResolverService,
    FxService,
    ProviderBridgeService,
  ],
  exports: [RateResolverService, FxService, ProviderBridgeService],
})
export class FinanceControlsModule {}
