import { Global, Module } from "@nestjs/common";
import { MembershipStateService } from "./membership-state.service";

@Global()
@Module({
  providers: [MembershipStateService],
  exports: [MembershipStateService],
})
export class AuthContextModule {}
