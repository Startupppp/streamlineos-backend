import { Module } from "@nestjs/common";
import { BudgetsController } from "./budgets.controller";
import { ScenariosController } from "./scenarios.controller";
import { BudgetsService } from "./budgets.service";
import { BvaService } from "./bva.service";
import { ForecastService } from "./forecast.service";
import { ScenariosService } from "./scenarios.service";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [NotificationsModule],
  controllers: [BudgetsController, ScenariosController],
  providers: [BudgetsService, BvaService, ForecastService, ScenariosService],
})
export class FinancePlanningModule {}
