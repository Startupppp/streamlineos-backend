import { Global, Module } from "@nestjs/common";
import { MembershipStateService } from "./membership-state.service";
import { JwtKeyringService } from "./jwt-keyring.service";

@Global()
@Module({
  providers: [MembershipStateService, JwtKeyringService],
  exports: [MembershipStateService, JwtKeyringService],
})
export class AuthContextModule {}
