import { readBankDetails } from "../../../../common/hr/canonical-bank-details";
import { OnboardingDetailsService } from "./onboarding-details.service";
import type { BankDetailsInput } from "./dto/onboarding.schemas";

const ORG_ID = "org-roundtrip";
const USER_ID = "user-roundtrip";

const US_INPUT = {
  countryCode: "US",
  accountHolder: "Ada Lovelace",
  bankName: "Example Bank",
  accountNumber: "000123456789",
  routingCode: "021000021",
  statutory: { ssn: "123-45-6789" },
} as unknown as BankDetailsInput;

const IN_INPUT = {
  countryCode: "IN",
  accountHolder: "Ada Lovelace",
  bankName: "Example Bank",
  accountNumber: "123456789012",
  routingCode: "HDFC0001234",
  statutory: { pan: "ABCDE1234F", uan: "100000000000" },
} as unknown as BankDetailsInput;

function makeHarness() {
  const sealed: string[] = [];

  const selectChain = (rows: unknown[]) => ({
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
      }),
    }),
  });

  const tx = {
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
    },
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn(() => selectChain([{ id: 9 }])),
    insert: jest.fn(() => ({
      values: jest.fn((values: { bankDetails: string }) => {
        sealed.push(values.bankDetails);
        return {
          onConflictDoUpdate: jest.fn().mockResolvedValue([]),
          onConflictDoNothing: jest.fn().mockResolvedValue([]),
        };
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    })),
  };

  const db = {
    ...tx,
    transaction: jest.fn((fn: (inner: unknown) => Promise<unknown>) => fn(tx)),
  };

  const service = new OnboardingDetailsService(
    db as never,
    { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
    { ensureFromUserId: jest.fn().mockResolvedValue(null) } as never,
  );

  jest
    .spyOn(
      service as unknown as { upsertOnboardingStep: () => Promise<void> },
      "upsertOnboardingStep",
    )
    .mockResolvedValue(undefined);

  return { service, sealed };
}

describe("saveBankDetails — what is written is what comes back", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("persists the routing code under routingCode, not a key the decode schema strips", async () => {
    const harness = makeHarness();

    await harness.service.saveBankDetails(ORG_ID, USER_ID, US_INPUT);

    const stored = readBankDetails(harness.sealed[0]);
    expect(stored?.routingCode).toBe("021000021");
  });

  it("persists bankCountry so a non-India employee is not read back as IN", async () => {
    const harness = makeHarness();

    await harness.service.saveBankDetails(ORG_ID, USER_ID, US_INPUT);

    const stored = readBankDetails(harness.sealed[0]);
    expect(stored?.bankCountry).toBe("US");
    expect(stored?.scheme).toBe("ABA_ROUTING");
  });

  it("persists every statutory field, not only the primary tax id", async () => {
    const harness = makeHarness();

    await harness.service.saveBankDetails(ORG_ID, USER_ID, IN_INPUT);

    const stored = readBankDetails(harness.sealed[0]);
    expect(stored?.statutory).toEqual({ pan: "ABCDE1234F", uan: "100000000000" });
  });

  it("keeps the account identifiers it always kept", async () => {
    const harness = makeHarness();

    await harness.service.saveBankDetails(ORG_ID, USER_ID, IN_INPUT);

    const stored = readBankDetails(harness.sealed[0]);
    expect(stored?.accountNumber).toBe("123456789012");
    expect(stored?.accountHolder).toBe("Ada Lovelace");
    expect(stored?.bankName).toBe("Example Bank");
    expect(stored?.ifsc).toBe("HDFC0001234");
  });
});
