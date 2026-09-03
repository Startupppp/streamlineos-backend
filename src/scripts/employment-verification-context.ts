import { Module } from "@nestjs/common";
import { DrizzleModule } from "../db/drizzle.module";
import { RegionModule } from "../common/region/region.module";
import { EmploymentFactsService } from "../modules/directory/employment-facts.service";

// This context provides EmploymentFactsService directly instead of importing
// EmploymentFactsModule, and that is deliberate.
//
// EmploymentFactsModule declares EmploymentFactsController. Registering the module here
// therefore instantiated the controller, which instantiated JwtAuthGuard and
// PermissionGuard, which pulled in REDIS, MembershipStateService, JwtKeyringService and
// AccessService — each supplied in production by a module that is @Global() but only
// becomes global once app.module.ts puts it in the graph. From this standalone context
// none of them were, so the script died at bootstrap with UnknownDependenciesException
// ("dependency 'REDIS' cannot be resolved") and never reached a single assertion.
// Chasing that chain would mean reconstructing AppModule to run three assertions.
//
// The script only ever calls EmploymentFactsService, whose sole dependency is DRIZZLE
// (employment-facts.service.ts:64). Providing it directly keeps the boot to what the
// verification actually exercises — the same shape verify-membership-revocation.ts uses.
@Module({
  imports: [DrizzleModule, RegionModule],
  providers: [EmploymentFactsService],
  exports: [EmploymentFactsService],
})
export class EmploymentVerificationContextModule {}
