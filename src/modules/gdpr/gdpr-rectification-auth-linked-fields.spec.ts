import type { Db } from "../../db/drizzle.module";
import { GdprRectificationService } from "./gdpr-rectification.service";
import {
  gdprRectificationBodySchema,
  type GdprRectificationBody,
} from "./dto/gdpr-rectification.schemas";

/**
 * Columns that decide who a caller IS. Changing any of them re-points an account's
 * sign-in identity, so a self-service correction must not write them without a
 * challenge proving control of the new value. There is no challenge in this module,
 * so the rectification surface must not reach them at all.
 */
const AUTHENTICATION_LINKED_COLUMNS = [
  "email",
  "emailVerified",
  "password",
  "passwordHash",
  "mfaSecret",
  "mfaEnabled",
  "backupCodes",
] as const;

const ACCEPTED_FIELDS: GdprRectificationBody[] = [
  { field: "profile.name", value: "Ananya Rao" },
  { field: "hr_profile.personal_email", value: "ananya@example.com" },
  { field: "hr_profile.phone", value: "+91 90000 00000" },
  { field: "hr_profile.date_of_birth", value: "1990-01-01" },
  { field: "hr_profile.gender", value: "female" },
  { field: "hr_profile.preferred_name", value: "Anu" },
  { field: "hr_profile.address", value: { city: "Pune" } },
  { field: "hr_profile.emergency_contact", value: { name: "Rao" } },
  { field: "hr_sensitive.bank_details", value: "acct-1" },
];

function harness() {
  const setPayloads: Array<Record<string, unknown>> = [];
  const update = jest.fn().mockImplementation(() => ({
    set: jest.fn().mockImplementation((payload: Record<string, unknown>) => {
      setPayloads.push(payload);
      return {
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: "person-1", ...payload }]),
        }),
      };
    }),
  }));

  function selectRows(value: unknown[]) {
    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(value),
          then: (
            resolve: (v: unknown) => unknown,
            reject?: (r: unknown) => unknown,
          ) => Promise.resolve(value).then(resolve, reject),
        }),
      }),
    };
  }

  let selectCount = 0;
  const tx = {
    select: jest.fn().mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return selectRows([{ id: 1, status: "ACTIVE" }]);
      if (selectCount === 2)
        return selectRows([
          {
            id: "person-1",
            name: "Ananya Roy",
            personalEmail: null,
            phone: null,
            dateOfBirth: null,
            gender: null,
            preferredName: null,
            address: null,
            emergencyContact: null,
          },
        ]);
      if (selectCount === 3) return selectRows([{ id: 10 }]);
      if (selectCount === 4) return selectRows([{ id: 20 }]);
      return selectRows([{ id: 30, bankDetails: "old" }]);
    }),
    update,
    insert: jest
      .fn()
      .mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 17 }]),
        }),
      })
      .mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
  };

  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    transaction: jest.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
  };

  return {
    service: new GdprRectificationService(db as unknown as Db),
    setPayloads,
  };
}

describe("GDPR rectification — authentication-linked fields need a challenge, so they are not offered", () => {
  it.each([
    "profile.email",
    "auth.email",
    "profile.password",
    "auth.password",
    "profile.email_verified",
    "auth.mfa",
  ])("(bite proof) the request schema rejects %s", (field) => {
    const parsed = gdprRectificationBodySchema.safeParse({
      field,
      value: "attacker@example.com",
    });
    expect(parsed.success).toBe(false);
  });

  it("(bite proof) no accepted correction writes an authentication-linked column", async () => {
    for (const input of ACCEPTED_FIELDS) {
      const { service, setPayloads } = harness();
      await service.rectifyOwnProfile("org-1", "user-1", input, "127.0.0.1");

      const written = setPayloads.flatMap((payload) => Object.keys(payload));
      for (const column of AUTHENTICATION_LINKED_COLUMNS)
        expect(written).not.toContain(column);
    }
  });

  it("every accepted field is a real correction — it writes the submitted value, not a redaction", async () => {
    const { service, setPayloads } = harness();
    await service.rectifyOwnProfile(
      "org-1",
      "user-1",
      { field: "hr_profile.preferred_name", value: "Anu" },
      "127.0.0.1",
    );

    expect(setPayloads).toEqual([{ preferredName: "Anu" }]);
  });

  it("the schema's field list is exactly the audited set — a new field forces this test to be revisited", () => {
    const accepted = ACCEPTED_FIELDS.map((input) => input.field).sort();
    const rejectsUnknown = gdprRectificationBodySchema.safeParse({
      field: "profile.unknown",
      value: "x",
    });

    expect(rejectsUnknown.success).toBe(false);
    for (const field of accepted)
      expect(
        gdprRectificationBodySchema.safeParse(
          ACCEPTED_FIELDS.find((input) => input.field === field),
        ).success,
      ).toBe(true);
  });
});
