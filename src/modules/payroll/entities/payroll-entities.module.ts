import { Module } from "@nestjs/common";
import { PayrollEntitiesService } from "./entities.service";

/**
 * Shared legal-entity + period helpers for multi-entity payroll.
 * Imported by runs/filings so entity ownership and isolation stay centralized.
 */
@Module({
  providers: [PayrollEntitiesService],
  exports: [PayrollEntitiesService],
})
export class PayrollEntitiesModule {}
