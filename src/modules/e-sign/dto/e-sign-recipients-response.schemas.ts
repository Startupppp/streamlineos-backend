import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const signRecipientRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int(),
  roleName: z.string(),
  recipientType: z.enum(["signer", "approver", "cc", "viewer", "in_person_host", "internal_reviewer"]),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  userMembershipId: z.number().int().nullable(),
  routingOrder: z.number().int(),
  status: z.enum(["pending", "invited", "viewed", "authenticated", "signing", "completed", "declined", "delegated", "bounced", "expired"]),
  authMethod: z.enum(["email_link", "access_code", "otp_email", "otp_sms", "sso", "passkey", "kba", "id_verification"]),
  accessCodeHash: z.string().nullable(),
  otpCodeHash: z.string().nullable(),
  otpExpiresAt: nullableWireDate(),
  otpAttempts: z.number().int(),
  failedAuthAttempts: z.number().int(),
  authLockedUntil: nullableWireDate(),
  signingTokenHash: z.string().nullable(),
  tokenExpiresAt: nullableWireDate(),
  tokenRevokedAt: nullableWireDate(),
  consentAcceptedAt: nullableWireDate(),
  consentIp: z.string().nullable(),
  consentUserAgent: z.string().nullable(),
  consentDisclosureVersion: z.string().nullable(),
  delegatedToRecipientId: z.number().int().nullable(),
  viewedAt: nullableWireDate(),
  authenticatedAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  declinedAt: nullableWireDate(),
  declinedReason: z.string().nullable(),
  bouncedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const recipientMutationResponseSchema = signRecipientRowSchema;

export const listRecipientsResponseSchema = z.array(signRecipientRowSchema);
