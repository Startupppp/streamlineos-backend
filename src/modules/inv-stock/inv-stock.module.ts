import { Module } from "@nestjs/common";
import { InvStockController } from "./inv-stock.controller";
import { InvStockService } from "./inv-stock.service";

@Module({
  controllers: [InvStockController],
  providers: [InvStockService],
  exports: [InvStockService],
})
export class InvStockModule {}
