import { Module } from "@nestjs/common";
import { AccountingModule } from "../accounting/accounting.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ApprovalPoliciesController } from "./approval-policies.controller";
import { ApprovalsController } from "./approvals.controller";
import { AuditController } from "./audit.controller";
import { ExchangeRatesController } from "./exchange-rates.controller";
import { ApprovalPoliciesService } from "./approval-policies.service";
import { ApprovalsService } from "./approvals.service";
import { AuditSurfaceService } from "./audit-surface.service";
import { ExchangeRatesService } from "./exchange-rates.service";
import { RateResolverService } from "./rate-resolver.service";
import { FxService } from "./fx.service";
import { ProviderBridgeService } from "./provider-bridge.service";

@Module({
  imports: [AccountingModule, NotificationsModule],
  controllers: [
    ApprovalPoliciesController,
    ApprovalsController,
    AuditController,
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
