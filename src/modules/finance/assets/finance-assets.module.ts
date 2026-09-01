import { Module } from "@nestjs/common";
import { AccountingModule } from "../../accounting/core/accounting.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { AssetCategoriesController } from "./asset-categories.controller";
import { FinanceAssetsController } from "./assets.controller";
import { DepreciationRunsController } from "./depreciation-runs.controller";
import { AssetCategoriesService } from "./asset-categories.service";
import { AssetsService } from "./assets.service";
import { DepreciationRunsService } from "./depreciation-runs.service";
import { DepreciationReverseService } from "./depreciation-reverse.service";

@Module({
  imports: [AccountingModule, NotificationsModule],
  controllers: [AssetCategoriesController, FinanceAssetsController, DepreciationRunsController],
  providers: [AssetCategoriesService, AssetsService, DepreciationRunsService, DepreciationReverseService],
  exports: [DepreciationRunsService],
})
export class FinanceAssetsModule {}
