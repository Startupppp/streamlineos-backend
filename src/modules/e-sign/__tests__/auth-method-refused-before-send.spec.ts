import { SignEnvelopeValidationService } from "../sign-envelope-validation.service";
import {
  SELF_SERVE_AUTH_METHODS,
  isSelfServeAuthMethod,
  signAuthMethodSchema,
} from "../dto/e-sign.schemas";

/**
 * An envelope may not pass validation and then be unsignable.
 *
 * `signAuthMethodSchema` offers eight authentication methods. `authenticate`
 * can complete three. The other five — otp_sms, sso, passkey, kba,
 * id_verification — were accepted by the composer, validated (otp_sms was even
 * required to carry a phone number), sent, and refused by the signing page with
 * "not yet supported for self-serve signing".
 *
 * That refusal was honest and in the wrong place. The sender chose the method
 * and could have chosen another; the signer receives a link that cannot work and
 * has no way to change it. So the check moves to the last moment the person who
 * can fix it is still holding the envelope.
 */
describe("an auth method the signing flow cannot complete", () => {
  function validatorWith(recipients: { name: string; authMethod: string; phone?: string | null }[]) {
    const rows = recipients.map((r, i) => ({
      id: i + 1,
      name: r.name,
      email: `${r.name}@example.invalid`,
      phone: r.phone ?? null,
      authMethod: r.authMethod,
      recipientType: "signer",
      routingOrder: 1,
    }));
    const db = {
      query: {
        signEnvelopes: { findFirst: jest.fn(async () => ({ id: 1, orgId: "org-1", routingMode: "parallel" })) },
        signDocuments: { findMany: jest.fn(async () => [{ id: 1 }]) },
        signFields: { findMany: jest.fn(async () => [{ id: 1, recipientId: 1, type: "signature" }]) },
      },
    };
    const recipientsService = { listForEnvelope: jest.fn(async () => rows) };
    return new SignEnvelopeValidationService(
      db as never,
      recipientsService as never,
    );
  }

  /**
   * THE ASSERTION THAT KEEPS THE TWO HALVES HONEST.
   *
   * The validator and `authenticate` must agree about which methods work. They
   * are two lists in two files, and the direction they drift in is the one where
   * an envelope validates and cannot be signed — so the list is exported once
   * and this pins the whole vocabulary against it. A method added to the enum
   * without a decision fails here rather than at somebody's signing link.
   */
  it("classifies every method in the product vocabulary, with none left undecided", () => {
    const all = signAuthMethodSchema.options;
    expect(all.length).toBe(8);

    const supported = all.filter((m) => isSelfServeAuthMethod(m));
    const unsupported = all.filter((m) => !isSelfServeAuthMethod(m));

    expect(supported).toEqual([...SELF_SERVE_AUTH_METHODS]);
    expect(unsupported).toEqual(["otp_sms", "sso", "passkey", "kba", "id_verification"]);
  });

  it.each(["otp_sms", "sso", "passkey", "kba", "id_verification"])(
    "refuses %s before the envelope is sent",
    async (method) => {
      const service = validatorWith([{ name: "priya", authMethod: method, phone: "+919999999999" }]);

      const result = await service.validate("org-1", 1);

      expect(result.valid).toBe(false);
      /*
       * The message has to name the method and say what would work. "Envelope is
       * invalid" sends the sender back to a composer with no indication of which
       * of eight choices to change.
       */
      const named = result.errors.find((e) => e.includes(method));
      expect(named).toBeDefined();
      expect(named).toContain("email_link");
    },
  );

  it.each([...SELF_SERVE_AUTH_METHODS])("still lets %s through", async (method) => {
    const service = validatorWith([{ name: "priya", authMethod: method }]);

    const result = await service.validate("org-1", 1);

    /*
     * Asserts on the auth error specifically, not on `valid`. A fixture missing
     * something unrelated would make a bare `valid === true` fail for a reason
     * this test is not about — and, worse, a bare `valid === false` pass.
     */
    expect(result.errors.filter((e) => e.includes("authentication, which"))).toEqual([]);
  });

  it("still demands a phone for otp_sms, so the older rule did not get dropped", async () => {
    const service = validatorWith([{ name: "priya", authMethod: "otp_sms", phone: null }]);

    const result = await service.validate("org-1", 1);

    expect(result.errors.some((e) => e.includes("phone number"))).toBe(true);
  });
});
