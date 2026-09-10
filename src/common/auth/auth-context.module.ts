import { Global, Module } from "@nestjs/common";
import { AuthContextFactory } from "./auth-context.factory";
import { MembershipStateService } from "./membership-state.service";
import { JwtKeyringService } from "./jwt-keyring.service";

@Global()
@Module({
  providers: [AuthContextFactory, MembershipStateService, JwtKeyringService],
  exports: [AuthContextFactory, MembershipStateService, JwtKeyringService],
})
export class AuthContextModule {}
