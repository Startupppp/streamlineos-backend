import { Module } from "@nestjs/common";
import { InvVendorsController } from "./inv-vendors.controller";
import { InvVendorsService } from "./inv-vendors.service";
import { VendorScorecardService } from "./vendor-scorecard.service";
import { InvReplenishmentModule } from "../replenishment/inv-replenishment.module";

@Module({
  // The scorecard reads lead times from the measured estimator; the percentile
  // definition lives in one place rather than being reimplemented here.
  imports: [InvReplenishmentModule],
  controllers: [InvVendorsController],
  providers: [InvVendorsService, VendorScorecardService],
  exports: [InvVendorsService, VendorScorecardService],
})
export class InvVendorsModule {}
