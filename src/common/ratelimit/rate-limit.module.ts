import { Global, Module } from "@nestjs/common";
import { RateLimitService } from "./rate-limit.service";
import { RateLimitGuard } from "./rate-limit.guard";

@Global()
@Module({ providers: [RateLimitService, RateLimitGuard], exports: [RateLimitService, RateLimitGuard] })
export class RateLimitModule {}
