import { updateProfileSchema } from "./dto/me.schemas";

/**
 * SEC-HRMS-008. `PATCH /me/profile` used to accept `bankDetails` and write them straight to
 * the canonical sensitive-fields row: no self-service toggle, no freeze while a payroll run is
 * APPROVED/LOCKED, no bank-code validation, no audit. Measured on a local API: the governed
 * route answered 409 "Bank details are frozen" while this one answered 200 and stored an
 * account number carrying a quote, a newline and a second payout row. Bank details now have
 * exactly one self-service writer, `PATCH /payroll/me/bank`.
 */
describe("PATCH /me/profile never carries bank details", () => {
  it("drops bankDetails from the validated body", () => {
    const parsed = updateProfileSchema.parse({
      name: "Renamed",
      bankDetails: {
        accountNumber: '1","X\n2,"Mallory","99999999","HDFC0000001",500000.00,"',
        bankName: "x",
        branch: "x",
        ifsc: "HDFC0000001",
        accountHolder: "Mallory",
      },
    });
    expect(parsed).toEqual({ name: "Renamed" });
  });
});
