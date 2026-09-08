import "reflect-metadata";
import {
  contactParamSchema,
  missingConsentQuerySchema,
  recordConsentSchema,
} from "./consent.schemas";
import {
  VALIDATION_SCHEMAS,
  type ValidationSchemas,
} from "../../../../common/validation/validate.decorator";
import { CrmConsentController } from "../crm-consent.controller";

const VALID = {
  channel: "EMAIL" as const,
  status: "OPTED_OUT" as const,
  source: "USER_ENTRY" as const,
};

describe("recordConsentSchema", () => {
  it("accepts an operator-recorded opt-out", () => {
    const parsed = recordConsentSchema.parse({
      ...VALID,
      legalBasis: "CONSENT",
      sourceDetail: "Phoned in",
    });

    expect(parsed.status).toBe("OPTED_OUT");
    expect(parsed.source).toBe("USER_ENTRY");
  });

  it("refuses UNSUBSCRIBE_LINK and WEB_FORM, so provenance cannot be forged", () => {
    for (const source of ["UNSUBSCRIBE_LINK", "WEB_FORM"]) {
      expect(() => recordConsentSchema.parse({ ...VALID, source })).toThrow();
    }
  });

  it("refuses a client-supplied actor id (§6 — identity comes from the token)", () => {
    expect(() =>
      recordConsentSchema.parse({ ...VALID, recordedByUserId: "someone-else" }),
    ).toThrow();
  });

  it("refuses an unknown channel", () => {
    expect(() =>
      recordConsentSchema.parse({ ...VALID, channel: "PIGEON" }),
    ).toThrow();
  });

  it("accepts a null expiry and coerces a date string", () => {
    expect(recordConsentSchema.parse({ ...VALID, expiresAt: null }).expiresAt).toBeNull();
    expect(
      recordConsentSchema.parse({ ...VALID, expiresAt: "2027-01-01T00:00:00Z" }).expiresAt,
    ).toBeInstanceOf(Date);
  });
});

describe("missingConsentQuerySchema", () => {
  it("requires a channel rather than defaulting to one", () => {
    expect(() => missingConsentQuerySchema.parse({})).toThrow();
    expect(missingConsentQuerySchema.parse({ channel: "SMS" }).channel).toBe("SMS");
  });
});

describe("contactParamSchema", () => {
  it("coerces the path string to the number the service signature declares", () => {
    const parsed = contactParamSchema.parse({ contactId: "42" });
    expect(parsed.contactId).toBe(42);
    expect(typeof parsed.contactId).toBe("number");
  });

  it("rejects a non-numeric, zero, negative or fractional contact id", () => {
    for (const contactId of ["abc", "0", "-1", "1.5"]) {
      expect(() => contactParamSchema.parse({ contactId })).toThrow();
    }
  });
});

describe("CrmConsentController param contract", () => {
  function paramsSchemaOf(handler: unknown) {
    const schemas = Reflect.getMetadata(VALIDATION_SCHEMAS, handler as object) as
      | ValidationSchemas
      | undefined;
    return schemas?.params;
  }

  it.each([
    ["listForContact", CrmConsentController.prototype.listForContact],
    ["record", CrmConsentController.prototype.record],
  ])("%s validates :contactId with contactParamSchema, not a string schema", (_name, handler) => {
    const params = paramsSchemaOf(handler);
    expect(params).toBe(contactParamSchema);
    expect(params?.parse({ contactId: "7" })).toEqual({ contactId: 7 });
  });
});
