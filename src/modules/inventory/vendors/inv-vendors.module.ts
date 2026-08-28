import { Module } from "@nestjs/common";
import { InvVendorsController } from "./inv-vendors.controller";
import { InvVendorsService } from "./inv-vendors.service";
import { InvReplenishmentModule } from "../replenishment/inv-replenishment.module";

@Module({
  // INV-307 folds measured lead times into the scorecard; the percentile
  // definition lives in one place rather than being reimplemented here.
  imports: [InvReplenishmentModule],
  controllers: [InvVendorsController],
  providers: [InvVendorsService],
  exports: [InvVendorsService],
})
export class InvVendorsModule {}
