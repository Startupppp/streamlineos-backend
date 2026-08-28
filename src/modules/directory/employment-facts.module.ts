import { Module } from "@nestjs/common";
import { EmploymentFactsService } from "./employment-facts.service";

@Module({
  providers: [EmploymentFactsService],
  exports: [EmploymentFactsService],
})
export class EmploymentFactsModule {}
