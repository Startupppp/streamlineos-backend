import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { UserProfileService } from "./user-profile.service";
import { UserOpsService } from "./user-ops.service";
import { OrganizationModule } from "../organization/core/organization.module";
import { SessionsModule } from "../sessions/sessions.module";
import { BillingModule } from "../billing/core/billing.module";
import { DirectoryModule } from "../directory/directory.module";

@Module({
  imports: [OrganizationModule, SessionsModule, BillingModule, DirectoryModule],
  controllers: [UsersController],
  providers: [UsersService, UserProfileService, UserOpsService],
  exports: [UsersService],
})
export class UsersModule {}
