import { Module } from "@nestjs/common";
import { InvReportsController } from "./inv-reports.controller";
import { InvReportsService } from "./inv-reports.service";

@Module({
  controllers: [InvReportsController],
  providers: [InvReportsService],
})
export class InvReportsModule {}
