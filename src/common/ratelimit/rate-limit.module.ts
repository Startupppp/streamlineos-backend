import { Global, Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { RateLimitService } from "./rate-limit.service";
import { RateLimitGuard } from "./rate-limit.guard";

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [RateLimitService, RateLimitGuard],
  exports: [DiscoveryModule, RateLimitService, RateLimitGuard],
})
export class RateLimitModule {}
