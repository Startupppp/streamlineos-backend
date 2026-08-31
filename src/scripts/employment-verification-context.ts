import { Module } from "@nestjs/common";
import { DrizzleModule } from "../db/drizzle.module";
import { RegionModule } from "../common/region/region.module";
import { EmploymentFactsModule } from "../modules/directory/employment-facts.module";

@Module({
  imports: [DrizzleModule, RegionModule, EmploymentFactsModule],
})
export class EmploymentVerificationContextModule {}
