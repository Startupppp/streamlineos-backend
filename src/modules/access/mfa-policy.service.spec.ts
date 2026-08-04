import { Test } from "@nestjs/testing";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { MfaPolicyService } from "./mfa-policy.service";

describe("MfaPolicyService", () => {
  it("fails closed when policy resolution errors", async () => {
    const db = {
      query: {
        organizations: { findFirst: jest.fn() },
        users: { findFirst: jest.fn() },
      },
    };
    const cache = {
      cached: jest.fn().mockRejectedValue(new Error("cache unavailable")),
      invalidate: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MfaPolicyService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();
    const service = moduleRef.get(MfaPolicyService);

    await expect(service.resolve("org-1", "user-1")).resolves.toEqual({
      enforced: true,
      satisfied: false,
    });
  });
});
