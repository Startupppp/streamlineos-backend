import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { AccountingAdaptersModule } from "../../accounting/adapters/accounting-adapters.module";
import { InvStockController } from "./inv-stock.controller";
import { InvStockAdjustmentsController } from "./inv-stock-adjustments.controller";
import { InvStockTransfersController } from "./inv-stock-transfers.controller";
import { InvStockService } from "./inv-stock.service";
import { InvStockReservationsService } from "./inv-stock-reservations.service";
import { InvStockAdjustmentsService } from "./inv-stock-adjustments.service";
import { InvStockTransfersService } from "./inv-stock-transfers.service";

@Module({
  imports: [InvStockEngineModule, AccountingAdaptersModule],
  controllers: [InvStockController, InvStockAdjustmentsController, InvStockTransfersController],
  providers: [InvStockService, InvStockReservationsService, InvStockAdjustmentsService, InvStockTransfersService],
  exports: [InvStockService, InvStockAdjustmentsService, InvStockTransfersService],
})
export class InvStockModule {}
