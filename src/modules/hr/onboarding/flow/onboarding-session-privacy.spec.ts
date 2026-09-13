import { OnboardingSessionService } from "./onboarding-session.service";
import { stripOnboardingDraftSecrets } from "./onboarding-session-privacy";

function buildDeepObject(wrapDepth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let current: Record<string, unknown> = leaf;
  for (let i = wrapDepth - 1; i >= 0; i--) {
    current = { [`l${i}`]: current };
  }
  return current;
}

const ORG_ID = "org-privacy";
const USER_ID = "user-privacy";

const SECRET_DRAFT = {
  personal: { phone: "+919000000000", addressCity: "Pune" },
  bank: {
    countryCode: "IN",
    accountHolder: "Jane Doe",
    bankName: "Example Bank",
    accountNumber: "123456789012",
    routingCode: "EXMP0000123",
    iban: "GB00EXMP00000000000000",
    swift: "EXMPINBBXXX",
    statutory: { pan: "AAAAA0000A", uan: "100000000000" },
  },
};

function plaintextLeaks(stored: unknown): string[] {
  const serialised = JSON.stringify(stored);
  return [
    "123456789012",
    "EXMP0000123",
    "GB00EXMP00000000000000",
    "EXMPINBBXXX",
    "AAAAA0000A",
    "100000000000",
  ].filter((secret) => serialised.includes(secret));
}

interface Harness {
  service: OnboardingSessionService;
  updates: { data?: unknown }[];
  findFirst: jest.Mock;
}

function makeHarness(existingData: Record<string, unknown>): Harness {
  const updates: { data?: unknown }[] = [];
  const findFirst = jest.fn().mockResolvedValue({
    id: "session-1",
    orgId: ORG_ID,
    userId: USER_ID,
    status: "in_progress",
    data: existingData,
  });

  const db = {
    query: { onboardingFlowSessions: { findFirst } },
    insert: jest.fn(),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn((values: { data?: unknown }) => {
        updates.push(values);
        return {
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: "session-1", ...values }]),
          }),
        };
      }),
    })),
  };

  const service = new OnboardingSessionService(db as never, {
    track: jest.fn().mockResolvedValue(undefined),
  } as never);

  return { service, updates, findFirst };
}

describe("onboarding draft privacy — P10", () => {
  describe("stripOnboardingDraftSecrets", () => {
    it("removes every bank and identity secret at any nesting depth", () => {
      expect(plaintextLeaks(stripOnboardingDraftSecrets(SECRET_DRAFT))).toEqual([]);
    });

    it("keeps the resumable, non-secret part of the draft", () => {
      expect(stripOnboardingDraftSecrets(SECRET_DRAFT)).toEqual({
        personal: { phone: "+919000000000", addressCity: "Pune" },
        bank: {
          countryCode: "IN",
          accountHolder: "Jane Doe",
          bankName: "Example Bank",
        },
      });
    });

    it("strips inside arrays too", () => {
      const stripped = stripOnboardingDraftSecrets({
        accounts: [{ bankName: "Example Bank", accountNumber: "123456789012" }],
      });
      expect(plaintextLeaks(stripped)).toEqual([]);
      expect(stripped).toEqual({ accounts: [{ bankName: "Example Bank" }] });
    });

    it("is case-insensitive about the secret key name", () => {
      expect(
        stripOnboardingDraftSecrets({ AccountNumber: "123456789012" }),
      ).toEqual({});
    });
  });

  describe("patchSession", () => {
    it("never writes a client-supplied secret into the session row", async () => {
      const harness = makeHarness({});

      await harness.service.patchSession(ORG_ID, USER_ID, "employee_onboarding", {
        data: SECRET_DRAFT,
      });

      const written = harness.updates.at(-1)?.data;
      expect(plaintextLeaks(written)).toEqual([]);
      expect(written).toMatchObject({
        bank: { countryCode: "IN", bankName: "Example Bank" },
      });
    });

    it("scrubs a secret an earlier release had already stored", async () => {
      const harness = makeHarness(SECRET_DRAFT);

      await harness.service.patchSession(ORG_ID, USER_ID, "employee_onboarding", {
        data: { personal: { phone: "+919000000001" } },
      });

      expect(plaintextLeaks(harness.updates.at(-1)?.data)).toEqual([]);
    });

    it("returns a resumable draft with no plaintext secret after a reload", async () => {
      const harness = makeHarness(SECRET_DRAFT);

      const session = await harness.service.getOrCreateSession(
        ORG_ID,
        USER_ID,
        "employee_onboarding",
      );

      expect(plaintextLeaks(session?.data)).toEqual([]);
      expect(session?.data).toMatchObject({ personal: { addressCity: "Pune" } });
    });

    it("does not carry a secret through a skip", async () => {
      const harness = makeHarness(SECRET_DRAFT);

      await harness.service.skipSession(ORG_ID, USER_ID, "employee_onboarding", "later");

      expect(plaintextLeaks(harness.updates.at(-1)?.data)).toEqual([]);
    });
  });

  describe("depth-boundary regression (P10)", () => {
    describe("stripOnboardingDraftSecrets at depth boundary", () => {
      it("strips a secret at wrap depth 8 (at MAX_DEPTH boundary)", () => {
        const obj = buildDeepObject(8, { accountNumber: "111122223333" });
        expect(JSON.stringify(stripOnboardingDraftSecrets(obj))).not.toContain("111122223333");
      });

      it("strips a secret at wrap depth 9 (one over MAX_DEPTH)", () => {
        const obj = buildDeepObject(9, { accountNumber: "444455556666" });
        expect(JSON.stringify(stripOnboardingDraftSecrets(obj))).not.toContain("444455556666");
      });

      it("strips a secret at wrap depth 10 (well over MAX_DEPTH)", () => {
        const obj = buildDeepObject(10, { pan: "TESTPA0000A" });
        expect(JSON.stringify(stripOnboardingDraftSecrets(obj))).not.toContain("TESTPA0000A");
      });

      it("strips an array subtree carrying a secret past the depth limit", () => {
        const obj = buildDeepObject(8, { items: [{ accountNumber: "777788889999" }] });
        expect(JSON.stringify(stripOnboardingDraftSecrets(obj))).not.toContain("777788889999");
      });

      it("strips a mixed-case secret key at wrap depth 9", () => {
        const obj = buildDeepObject(9, { AccountNumber: "000011112222" });
        expect(JSON.stringify(stripOnboardingDraftSecrets(obj))).not.toContain("000011112222");
      });
    });

    describe("service paths with over-depth data", () => {
      it("strips a legacy-poisoned deep secret on read", async () => {
        const deepPoisoned = buildDeepObject(9, { iban: "GBDEEPTEST1234567890" });
        const harness = makeHarness(deepPoisoned);
        const session = await harness.service.getOrCreateSession(ORG_ID, USER_ID, "employee_onboarding");
        expect(JSON.stringify(session?.data)).not.toContain("GBDEEPTEST1234567890");
      });

      it("never persists a deep-nested secret via patchSession", async () => {
        const deepPayload = buildDeepObject(9, { routingCode: "DEEP0ROUTE" });
        const harness = makeHarness({});
        await harness.service.patchSession(ORG_ID, USER_ID, "employee_onboarding", { data: deepPayload });
        expect(JSON.stringify(harness.updates.at(-1)?.data)).not.toContain("DEEP0ROUTE");
      });

      it("never persists a deep-nested secret through a skip", async () => {
        const deepPoisoned = buildDeepObject(9, { swift: "DEEPSWIFTXX" });
        const harness = makeHarness(deepPoisoned);
        await harness.service.skipSession(ORG_ID, USER_ID, "employee_onboarding", "later");
        expect(JSON.stringify(harness.updates.at(-1)?.data)).not.toContain("DEEPSWIFTXX");
      });
    });
  });
});
