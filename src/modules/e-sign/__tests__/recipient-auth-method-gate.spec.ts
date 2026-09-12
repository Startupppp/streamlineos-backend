import { BadRequestException } from "@nestjs/common";
import { SignRecipientsService } from "../sign-recipients.service";
import { SignAuthMethodPolicy } from "../sign-auth-method.policy";

/**
 * SIGN-P0-03 / P0-04 / P1-03, tested through the *other* door.
 *
 * The auth-method gate was added to `add`, and only to `add`. `update` writes
 * `patch.authMethod = input.authMethod` with no check at all, and
 * `updateRecipientSchema` is `createRecipientSchema.partial()` — so the same
 * eight-value enum is accepted there. One PATCH restores exactly the state the
 * three tickets were written to end: a recipient configured for a method
 * `authenticate` refuses with "not yet supported", discovered by the customer
 * holding the signing link.
 *
 * Worse than at creation, in fact. `add` is refused unless the envelope is
 * still editable; `update` only refuses when the envelope is terminal, and a
 * *sent* envelope is neither editable nor terminal. So the method can be
 * changed underneath a recipient who has already been invited.
 *
 * Nothing downstream catches it. `validateForSend` checks that an `otp_sms`
 * recipient has a phone number — not that the method is enabled for the org or
 * deliverable in this environment — and validation does not run again after a
 * send in any case.
 */

type Recipient = {
  id: number;
  orgId: string;
  envelopeId: number;
  name: string;
  status: string;
  phone: string | null;
  authMethod: string;
};

function buildService(opts: {
  recipient: Partial<Recipient>;
  envelopeStatus?: string;
  allowedAuthMethods: string[];
  smsConfigured: boolean;
}) {
  const recipient: Recipient = {
    id: 1,
    orgId: "org_1",
    envelopeId: 10,
    name: "Signer Person",
    status: "invited",
    phone: null,
    authMethod: "email_link",
    ...opts.recipient,
  };

  const updated: Record<string, unknown>[] = [];

  const db = {
    query: {
      signRecipients: { findFirst: async () => recipient },
      signEnvelopes: {
        findFirst: async () => ({
          id: 10,
          orgId: "org_1",
          status: opts.envelopeStatus ?? "sent",
          routingMode: "parallel",
        }),
      },
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updated.push(patch);
            return [{ ...recipient, ...patch }];
          },
        }),
      }),
    }),
  };

  /** The real policy, so this exercises the gate rather than a test double of it. */
  const policy = new SignAuthMethodPolicy(
    { getOrCreate: async () => ({ allowedAuthMethods: opts.allowedAuthMethods }) } as never,
    { isConfigured: () => opts.smsConfigured, send: async () => undefined } as never,
  );

  const service = new SignRecipientsService(
    db as never,
    { record: async () => undefined } as never,
    { hash: (v: string) => `hash:${v}` } as never,
    policy,
  );

  return { service, updated };
}

const ACTOR = { orgId: "org_1", userId: "user_1" } as never;

describe("recipient auth method gate applies on update, not only on create", () => {
  it("refuses a method the organisation has not enabled", async () => {
    const { service, updated } = buildService({
      recipient: {},
      allowedAuthMethods: ["email_link", "access_code", "otp_email"],
      smsConfigured: false,
    });

    await expect(
      service.update("org_1", 1, { authMethod: "passkey" }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);

    /**
     * The refusal has to happen before the write. A gate that throws after
     * `set()` has already run leaves the row changed and the caller told no.
     */
    expect(updated).toHaveLength(0);
  });

  it("names the method and the enabled list, so the operator can act on it", async () => {
    const { service } = buildService({
      recipient: {},
      allowedAuthMethods: ["email_link", "otp_email"],
      smsConfigured: false,
    });

    await expect(
      service.update("org_1", 1, { authMethod: "id_verification" }, ACTOR),
    ).rejects.toThrow(/id_verification.*not enabled/s);
  });

  it("refuses otp_sms when this environment cannot deliver an SMS", async () => {
    /**
     * Enabled is not the same as available, and the two need different
     * messages — one is a settings change, the other is a deployment problem.
     */
    const { service, updated } = buildService({
      recipient: { phone: "+15550100" },
      allowedAuthMethods: ["email_link", "otp_email", "otp_sms"],
      smsConfigured: false,
    });

    await expect(
      service.update("org_1", 1, { authMethod: "otp_sms" }, ACTOR),
    ).rejects.toThrow(/no SMS provider is configured/);
    expect(updated).toHaveLength(0);
  });

  it("refuses otp_sms when neither the patch nor the stored row has a phone", async () => {
    const { service } = buildService({
      recipient: { phone: null },
      allowedAuthMethods: ["otp_sms"],
      smsConfigured: true,
    });

    await expect(
      service.update("org_1", 1, { authMethod: "otp_sms" }, ACTOR),
    ).rejects.toThrow(/Phone number is required/);
  });

  it("accepts otp_sms against the phone already on the row, not just the patch", async () => {
    /**
     * The number usually arrives in an earlier request than the method does.
     * Reading only the patch would refuse a recipient who has had a phone
     * number on file all along — a false refusal is as much a broken promise
     * as a false acceptance.
     */
    const { service, updated } = buildService({
      recipient: { phone: "+15550100" },
      allowedAuthMethods: ["otp_sms"],
      smsConfigured: true,
    });

    await service.update("org_1", 1, { authMethod: "otp_sms" }, ACTOR);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ authMethod: "otp_sms" });
  });

  it("still allows a method the organisation has enabled", async () => {
    const { service, updated } = buildService({
      recipient: {},
      allowedAuthMethods: ["email_link", "access_code", "otp_email"],
      smsConfigured: false,
    });

    await service.update("org_1", 1, { authMethod: "otp_email" }, ACTOR);
    expect(updated[0]).toMatchObject({ authMethod: "otp_email" });
  });

  it("leaves an update that does not touch authMethod alone", async () => {
    /**
     * The gate reads org settings, so making it run on every PATCH would add a
     * query to renaming a recipient. More importantly it would start refusing
     * edits to rows created under an older allowlist — the name change would
     * fail because of a field the caller never mentioned.
     */
    const { service, updated } = buildService({
      recipient: { authMethod: "passkey" },
      allowedAuthMethods: ["email_link"],
      smsConfigured: false,
    });

    await service.update("org_1", 1, { name: "Renamed Person" }, ACTOR);
    expect(updated[0]).toMatchObject({ name: "Renamed Person" });
    expect(updated[0]).not.toHaveProperty("authMethod");
  });
});
