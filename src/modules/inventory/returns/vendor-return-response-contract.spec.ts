import {
  getVendorReturnResponseSchema,
  listVendorReturnsResponseSchema,
} from "./dto/returns-response.schemas";
import { invVendorReturnReasonEnum } from "../../../db/schema/common/enums-inventory";

function aVendorReturn() {
  return {
    id: 1,
    orgId: "org-1",
    returnNumber: "VR-0001",
    vendorId: 9,
    poId: null,
    grnId: null,
    status: "APPROVED",
    notes: null,
    createdBy: "user-1",
    createdByMembershipId: 4,
    approvedBy: "user-2",
    approvedByMembershipId: 5,
    approvedAt: new Date("2026-02-01T00:00:00.000Z"),
    creditReference: "CN-77",
    postedAt: null,
    cancelledAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    vendor: { id: 9, name: "Acme Supplies" },
    lines: [
      {
        id: 3,
        returnId: 1,
        productVariantId: 11,
        lotId: null,
        serialId: null,
        quantity: "2",
        reason: "DAMAGED",
        unitCost: "10.00",
      },
    ],
  };
}

describe("the vendor return a caller actually receives", () => {
  it("carries the vendor the loader joins, because a return that names only vendorId makes the table show a number where a supplier belongs", () => {
    const parsed = getVendorReturnResponseSchema.parse(aVendorReturn());

    expect(parsed.vendor).toEqual({ id: 9, name: "Acme Supplies" });
  });

  it("carries approvedAt, which approve() writes and nothing was sending back", () => {
    const parsed = getVendorReturnResponseSchema.parse(aVendorReturn());

    expect(parsed.approvedAt).not.toBeUndefined();
  });

  it("carries creditReference, so a raised credit note is visible to the person who raised it", () => {
    const parsed = getVendorReturnResponseSchema.parse(aVendorReturn());

    expect(parsed.creditReference).toBe("CN-77");
  });

  it("carries the reason on every line, which is the whole point of returning goods to a vendor", () => {
    const parsed = getVendorReturnResponseSchema.parse(aVendorReturn());

    expect(parsed.lines?.[0]?.reason).toBe("DAMAGED");
  });

  it("keeps the same four fields through the list envelope, because the list is where the columns are read", () => {
    const parsed = listVendorReturnsResponseSchema.parse({
      items: [aVendorReturn()],
      total: 1,
      page: 1,
      totalPages: 1,
    });

    const row = parsed.items[0];
    expect(row?.vendor?.name).toBe("Acme Supplies");
    expect(row?.creditReference).toBe("CN-77");
    expect(row?.lines?.[0]?.reason).toBe("DAMAGED");
  });

  it("refuses a reason outside the database enum, so the column and the contract cannot drift apart", () => {
    const row = aVendorReturn();
    row.lines[0]!.reason = "RETURNED_BY_CUSTOMER";

    expect(() => getVendorReturnResponseSchema.parse(row)).toThrow();
  });

  it("accepts every reason the database enum declares, so the assertion above is about the vocabulary and not about rejecting everything", () => {
    for (const reason of invVendorReturnReasonEnum.enumValues) {
      const row = aVendorReturn();
      row.lines[0]!.reason = reason;

      expect(() => getVendorReturnResponseSchema.parse(row)).not.toThrow();
    }
  });
});
