import { Module } from "@nestjs/common";
import { InvVendorsController } from "./inv-vendors.controller";
import { InvVendorsService } from "./inv-vendors.service";

@Module({
  controllers: [InvVendorsController],
  providers: [InvVendorsService],
  exports: [InvVendorsService],
})
export class InvVendorsModule {}
