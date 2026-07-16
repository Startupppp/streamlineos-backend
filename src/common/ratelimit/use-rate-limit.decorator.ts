import { SetMetadata } from "@nestjs/common";

export const RATE_LIMIT_TIER = "rate_limit_tier";
export const UseRateLimit = (tier: string) => SetMetadata(RATE_LIMIT_TIER, tier);
