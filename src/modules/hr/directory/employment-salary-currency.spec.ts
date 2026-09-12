import { BadRequestException } from "@nestjs/common";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import {
  UNSUPPORTED_SALARY_CURRENCY_MESSAGE,
  assertSalaryCurrency,
  resolveOrgSalaryCurrency,
} from "./employment-salary-currency";

const ORG_ID = "org-currency";

function executorReturning(rows: unknown[]): DbOrTx {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  } as unknown as DbOrTx;
}

describe("employment salary currency — P13", () => {
  describe("assertSalaryCurrency", () => {
    it("accepts the organization's stored code", () => {
      expect(assertSalaryCurrency("USD")).toBe("USD");
    });

    it("normalises case and padding rather than rejecting a stored variant", () => {
      expect(assertSalaryCurrency("  gbp ")).toBe("GBP");
    });

    it.each([null, undefined, "", "IN", "INRR", "12", "US$"])(
      "rejects %p explicitly instead of substituting INR",
      (raw) => {
        expect(() => assertSalaryCurrency(raw)).toThrow(
          new BadRequestException(UNSUPPORTED_SALARY_CURRENCY_MESSAGE),
        );
      },
    );

    it("does not treat INR as a fallback for an unusable value", () => {
      let thrown: unknown = null;
      try {
        assertSalaryCurrency("not-a-code");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
    });
  });

  describe("resolveOrgSalaryCurrency", () => {
    it("returns the organization's own currency, not a constant", async () => {
      await expect(
        resolveOrgSalaryCurrency(executorReturning([{ currency: "AED" }]), ORG_ID),
      ).resolves.toBe("AED");
    });

    it("rejects when the organization row is missing", async () => {
      await expect(
        resolveOrgSalaryCurrency(executorReturning([]), ORG_ID),
      ).rejects.toThrow(new BadRequestException(UNSUPPORTED_SALARY_CURRENCY_MESSAGE));
    });

    it("rejects when the stored currency is unusable", async () => {
      await expect(
        resolveOrgSalaryCurrency(executorReturning([{ currency: "" }]), ORG_ID),
      ).rejects.toThrow(new BadRequestException(UNSUPPORTED_SALARY_CURRENCY_MESSAGE));
    });
  });
});
