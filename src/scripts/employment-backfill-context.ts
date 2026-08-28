import { Module } from "@nestjs/common";
import { DrizzleModule } from "../db/drizzle.module";
import { RegionModule } from "../common/region/region.module";
import { EmploymentMigrationModule } from "../modules/hr/core/employment-migration.module";

@Module({
  imports: [DrizzleModule, RegionModule, EmploymentMigrationModule],
})
export class EmploymentBackfillContextModule {}
