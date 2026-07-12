import { Module } from "@nestjs/common";
import { AccountingModule } from "../accounting/accounting.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AssetCategoriesController } from "./asset-categories.controller";
import { AssetsController } from "./assets.controller";
import { DepreciationRunsController } from "./depreciation-runs.controller";
import { AssetCategoriesService } from "./asset-categories.service";
import { AssetsService } from "./assets.service";
import { DepreciationRunsService } from "./depreciation-runs.service";

@Module({
  imports: [AccountingModule, NotificationsModule],
  controllers: [AssetCategoriesController, AssetsController, DepreciationRunsController],
  providers: [AssetCategoriesService, AssetsService, DepreciationRunsService],
  exports: [DepreciationRunsService],
})
export class FinanceAssetsModule {}
