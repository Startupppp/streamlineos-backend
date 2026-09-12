import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { CommissionController } from "./commission.controller";
import { CommissionService } from "./commission.service";
import { CommissionAccrualController } from "./commission-accrual.controller";
import { CommissionAccrualService } from "./commission-accrual.service";

/**
 * Commission plans as dated, versioned rules — and the accrual they produce.
 *
 * A sibling of `modules/sales`, not a part of it: `sales` owns the legacy
 * `commission_rules`/`commissions` pair, which is undated and stores money in
 * `decimal`. Standing this up inside that module would have meant one service
 * holding two contradictory answers to "what is the rate", which is how the
 * undated one would have won by being the one already imported.
 *
 * The accrual half lives here rather than in a module of its own because it is
 * not a separate concern: `CommissionService.calculateForDeal` writes the
 * decomposition in the same transaction as the earning, which is what makes an
 * accrual impossible to have without the parts that explain it. Splitting the
 * two into different modules would put a transaction boundary between an earning
 * and its own derivation.
 *
 * Note the direction of the dependency. `CommissionService` imports two plain
 * functions from the accrual side; nothing is injected across, so there is no
 * cycle for Nest to resolve and no `forwardRef` for anybody to wonder about.
 *
 * Exports both services so a later payroll handoff can read approved earnings —
 * and the decomposition behind them — without going through HTTP.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [CommissionController, CommissionAccrualController],
  providers: [CommissionService, CommissionAccrualService],
  exports: [CommissionService, CommissionAccrualService],
})
export class CommissionModule {}
