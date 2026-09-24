import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { PublicOffersService } from "./public-offers.service";

describe("PublicOffersService — cross-tenant isolation", () => {
  const INVALID_TOKEN = "tok-invalid";
  const VALID_TOKEN = "tok-valid";

  function makeDb(offerRow: unknown): Db {
    return {
      query: {
        candidateOffers: { findFirst: jest.fn().mockResolvedValue(offerRow) },
        candidates: { findFirst: jest.fn().mockResolvedValue(null) },
        organizations: { findFirst: jest.fn().mockResolvedValue({ id: "org-owner", name: "Corp" }) },
        interviewBookingLinks: { findFirst: jest.fn().mockResolvedValue(null) },
        offerNegotiations: { findMany: jest.fn().mockResolvedValue([]) },
      },
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        query: {
          candidateOffers: { findFirst: jest.fn().mockResolvedValue(offerRow) },
          candidates: { findFirst: jest.fn().mockResolvedValue(null) },
          organizations: { findFirst: jest.fn().mockResolvedValue({ id: "org-owner", name: "Corp" }) },
          interviewBookingLinks: { findFirst: jest.fn().mockResolvedValue(null) },
          offerNegotiations: { findMany: jest.fn().mockResolvedValue([]) },
        },
        execute: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as Db;
  }

  it("throws NotFoundException for a missing token (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new PublicOffersService(db, {} as never);
    await expect(svc.getOffer(INVALID_TOKEN)).rejects.toThrow(NotFoundException);
  });

  it("returns the offer for a valid token (control — correct token)", async () => {
    const offerRow = {
      id: 1, orgId: "org-owner", offerStatus: "PENDING", offeredSalary: 50000,
      offeredDesignation: "Engineer", joiningDate: null, validUntil: null,
      notes: null, acceptanceTokenExpiresAt: null,
    };
    const db = makeDb(offerRow);
    const svc = new PublicOffersService(db, {} as never);
    const result = await svc.getOffer(VALID_TOKEN);
    expect(result).toHaveProperty("offerStatus");
  });
});
