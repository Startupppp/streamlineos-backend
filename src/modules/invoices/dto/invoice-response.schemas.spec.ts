import { DB_ENUMS } from "../../../db/enums.generated";
import { invoiceCreateResponseSchema } from "./invoice-response.schemas";

describe("invoice-response.schemas — enum drift guard", () => {
  describe("invoice status vs invoice_status pgEnum", () => {
    it("rejects an invoice status outside the 8 members invoice_status declares, which z.string() accepted", () => {
      expect(() =>
        invoiceCreateResponseSchema.parse({
          id: 1,
          orgId: "org-1",
          clientId: null,
          projectId: null,
          dealId: null,
          invoiceNumber: "INV-001",
          status: "CANCELLED",
          subtotal: "10000",
          taxRate: "18",
          taxAmount: "1800",
          discount: "0",
          total: "11800",
          currency: "INR",
          dueDate: null,
          notes: null,
          sentAt: null,
          paidAt: null,
          viewedAt: null,
          terms: null,
          placeOfSupply: null,
          customerGstin: null,
          supplierGstin: null,
          reverseCharge: false,
          taxInclusive: false,
          cgstAmount: "0",
          sgstAmount: "0",
          igstAmount: "0",
          isRecurring: false,
          recurringInterval: null,
          nextRecurringDate: null,
          createdBy: "user-1",
          createdByMembershipId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          amountPaid: "0",
          exchangeRate: "1",
          collectionOwnerId: null,
          collectionOwnerMembershipId: null,
          promiseToPayDate: null,
          nextReminderAt: null,
          recurringTemplateId: null,
        }),
      ).toThrow();
    });

    it("invoiceCreateResponseSchema.shape.status member set equals DB_ENUMS.invoice_status exactly so a future pgEnum change cannot drift again", () => {
      const options = (invoiceCreateResponseSchema.shape.status as { options?: unknown[] }).options;
      expect(options).toBeDefined();
      expect([...(options ?? [])]).toEqual([...DB_ENUMS.invoice_status]);
    });
  });
});
