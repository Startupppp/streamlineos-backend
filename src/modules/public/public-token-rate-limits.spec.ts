import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { RATE_LIMIT_TIER } from "../../common/ratelimit/use-rate-limit.decorator";
import { effectiveRateLimit } from "../../common/ratelimit/rate-limit.service";
import { PublicController } from "./public.controller";

const EXPECTED: Array<{ method: keyof typeof PublicController.prototype; tier: string }> = [
  { method: "applicationStatus", tier: "public:application-status" },
  { method: "getOffer", tier: "public:offer" },
  { method: "respondToOffer", tier: "public:offer-respond" },
  { method: "getExternalReferrerPortal", tier: "public:referrer-portal" },
  { method: "submitExternalReferral", tier: "public:referral-submit" },
  { method: "getVendorPortal", tier: "public:vendor-portal" },
];

describe("public token endpoint rate-limit wiring", () => {
  for (const { method, tier } of EXPECTED) {
    describe(method, () => {
      const handler = PublicController.prototype[method] as object;

      it(`carries @UseRateLimit("${tier}") and the tier has a registered TIERS entry`, () => {
        expect(Reflect.getMetadata(RATE_LIMIT_TIER, handler)).toBe(tier);
        expect(effectiveRateLimit(tier)).toBeGreaterThan(0);
      });

      it("has RateLimitGuard in its guard list", () => {
        const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        expect(guards).toContain(RateLimitGuard);
      });
    });
  }
});
