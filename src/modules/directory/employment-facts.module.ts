import { Module } from "@nestjs/common";
import { EmploymentFactsService } from "./employment-facts.service";
import { EmploymentFactsController } from "./employment-facts.controller";

@Module({
  controllers: [EmploymentFactsController],
  providers: [EmploymentFactsService],
  exports: [EmploymentFactsService],
})
export class EmploymentFactsModule {}
