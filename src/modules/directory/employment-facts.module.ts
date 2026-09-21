import { Module } from "@nestjs/common";
import { EmploymentFactsService } from "./employment-facts.service";
import { EmploymentFactsController } from "./employment-facts.controller";
import { ReportingLineService } from "./reporting-line.service";

@Module({
  controllers: [EmploymentFactsController],
  providers: [EmploymentFactsService, ReportingLineService],
  exports: [EmploymentFactsService, ReportingLineService],
})
export class EmploymentFactsModule {}
