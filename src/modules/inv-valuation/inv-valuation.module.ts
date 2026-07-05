import { Module } from "@nestjs/common";
import { InvValuationController } from "./inv-valuation.controller";
import { InvValuationService } from "./inv-valuation.service";

@Module({
  controllers: [InvValuationController],
  providers: [InvValuationService],
  exports: [InvValuationService],
})
export class InvValuationModule {}
