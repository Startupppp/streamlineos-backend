jest.mock("../../../common/organization/organization-actor", () => ({
  assertOrganizationActor: jest.fn().mockResolvedValue({
    orgId: "org-1",
    userId: "user-1",
    membershipId: 1,
  }),
}));

import { ConflictException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import type { CreateTaxPaymentInput } from "./dto/tax-payments.schemas";
import { TaxPaymentsService } from "./tax-payments.service";

/**
 * A duplicate tax payment reference, as the database reports it.
 *
 * create translates a unique violation on the payment insert into a 409.
 * Drizzle hands it a DrizzleQueryError with the SQLSTATE on `.cause`, so the
 * read has to look through the wrapper. No constraint name is given: in
 * src/db/schema the only unique on acc_tax_payments is (org_id, id), and
 * uniq_acc_tax_payments_org_type_ref is declared as a plain index. This holds
 * the read, not the index.
 */

const actor: CurrentUserContext = {
  orgId: "org-1",
  userId: "user-1",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const input: CreateTaxPaymentInput = {
  taxType: "GST",
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  amount: "1500.00",
  paidDate: "2026-08-10",
  reference: "CHALLAN-001",
};

function makeService(insertError: Error): TaxPaymentsService {
  const db = {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockRejectedValue(insertError) }),
    }),
  } as unknown as Db;
  const posting = {
    resolveSystemAccount: jest.fn().mockResolvedValue(11),
    postJournal: jest.fn().mockResolvedValue({ entryId: 99 }),
  };
  return new TaxPaymentsService(db, {} as never, {} as never, {} as never, posting as never);
}

describe("TaxPaymentsService.create — duplicate reference", () => {
  it("answers 409 when the payment insert hits a unique violation", async () => {
    const service = makeService(drizzleUniqueViolation());
    await expect(service.create(actor, input)).rejects.toBeInstanceOf(ConflictException);
  });

  it("rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "some_fk");
    const service = makeService(fkViolation);
    await expect(service.create(actor, input)).rejects.toBe(fkViolation);
  });
});
