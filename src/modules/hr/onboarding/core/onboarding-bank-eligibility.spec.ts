import { ConflictException, NotFoundException } from "@nestjs/common";
import {
  BANK_DETAILS_NEED_EMPLOYMENT_MESSAGE,
  OnboardingDetailsService,
} from "./onboarding-details.service";

const ORG_ID = "org-bank";
const USER_ID = "user-bank";

const INPUT = {
  countryCode: "IN",
  accountHolder: "Jane Doe",
  bankName: "Example Bank",
  accountNumber: "123456789012",
  routingCode: "EXMP0000123",
  statutory: { pan: "AAAAA0000A" },
};

interface Harness {
  service: OnboardingDetailsService;
  inserted: string[];
  stepUpserts: number;
}

function makeHarness(options: {
  membership: { id: number } | null;
  employment: { id: number }[];
}): Harness {
  const state = { inserted: [] as string[], stepUpserts: 0 };

  const selectChain = (rows: unknown[]) => ({
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
      }),
      leftJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
      }),
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
    }),
  });

  const tx = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(options.membership),
      },
    },
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn(() => selectChain(options.employment)),
    insert: jest.fn(() => ({
      values: jest.fn(() => {
        state.inserted.push("hr_employee_sensitive_fields");
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

  const upsert = jest
    .spyOn(
      service as unknown as { upsertOnboardingStep: () => Promise<void> },
      "upsertOnboardingStep",
    )
    .mockImplementation(async () => {
      state.stepUpserts += 1;
    });
  expect(upsert).toBeDefined();

  return {
    service,
    get inserted() {
      return state.inserted;
    },
    get stepUpserts() {
      return state.stepUpserts;
    },
  };
}

describe("OnboardingDetailsService.saveBankDetails — P10 durable save or actionable error", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("refuses with actionable eligibility guidance when no employment row exists", async () => {
    const harness = makeHarness({ membership: { id: 1 }, employment: [] });

    await expect(
      harness.service.saveBankDetails(ORG_ID, USER_ID, INPUT as never),
    ).rejects.toThrow(new ConflictException(BANK_DETAILS_NEED_EMPLOYMENT_MESSAGE));
  });

  it("does not mark the step complete when the data was not persisted", async () => {
    const harness = makeHarness({ membership: { id: 1 }, employment: [] });

    await expect(
      harness.service.saveBankDetails(ORG_ID, USER_ID, INPUT as never),
    ).rejects.toThrow(ConflictException);

    expect(harness.stepUpserts).toBe(0);
    expect(harness.inserted).toEqual([]);
  });

  it("persists and completes the step when employment exists", async () => {
    const harness = makeHarness({ membership: { id: 1 }, employment: [{ id: 9 }] });

    await expect(
      harness.service.saveBankDetails(ORG_ID, USER_ID, INPUT as never),
    ).resolves.toEqual({ success: true });

    expect(harness.inserted).toEqual(["hr_employee_sensitive_fields"]);
    expect(harness.stepUpserts).toBe(1);
  });

  it("still refuses a caller who is not a member of this organization", async () => {
    const harness = makeHarness({ membership: null, employment: [{ id: 9 }] });

    await expect(
      harness.service.saveBankDetails(ORG_ID, USER_ID, INPUT as never),
    ).rejects.toThrow(NotFoundException);
  });
});
