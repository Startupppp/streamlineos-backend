import { signRecipients } from "../../../db/schema";

/**
 * The recipient row as it may leave the service.
 *
 * Three columns are missing on purpose. `access_code_hash`, `otp_code_hash` and
 * `signing_token_hash` are unsalted SHA-256 digests of secrets a signer proves
 * knowledge of: a 6-digit OTP or a short access code is recovered from its
 * digest in milliseconds, and the token digest is the lookup key for the public
 * signing session. Every internal read of a recipient — the sender's envelope
 * detail, the recipients list, the row an add or update returns — used to carry
 * all three, and the response contract declared them. Only the public
 * authentication path (`lib/recipient-identity.ts`) may read them, and it
 * selects them by name from its own query.
 */
export const RECIPIENT_WIRE_COLUMNS = {
  id: signRecipients.id,
  orgId: signRecipients.orgId,
  envelopeId: signRecipients.envelopeId,
  roleName: signRecipients.roleName,
  recipientType: signRecipients.recipientType,
  name: signRecipients.name,
  email: signRecipients.email,
  phone: signRecipients.phone,
  userMembershipId: signRecipients.userMembershipId,
  routingOrder: signRecipients.routingOrder,
  status: signRecipients.status,
  authMethod: signRecipients.authMethod,
  otpExpiresAt: signRecipients.otpExpiresAt,
  otpAttempts: signRecipients.otpAttempts,
  failedAuthAttempts: signRecipients.failedAuthAttempts,
  authLockedUntil: signRecipients.authLockedUntil,
  tokenExpiresAt: signRecipients.tokenExpiresAt,
  tokenRevokedAt: signRecipients.tokenRevokedAt,
  consentAcceptedAt: signRecipients.consentAcceptedAt,
  consentIp: signRecipients.consentIp,
  consentUserAgent: signRecipients.consentUserAgent,
  consentDisclosureVersion: signRecipients.consentDisclosureVersion,
  delegatedToRecipientId: signRecipients.delegatedToRecipientId,
  viewedAt: signRecipients.viewedAt,
  authenticatedAt: signRecipients.authenticatedAt,
  completedAt: signRecipients.completedAt,
  declinedAt: signRecipients.declinedAt,
  declinedReason: signRecipients.declinedReason,
  bouncedAt: signRecipients.bouncedAt,
  createdAt: signRecipients.createdAt,
  updatedAt: signRecipients.updatedAt,
} as const;

/** The same exclusion for the relational query API, which takes booleans rather than columns. */
export const RECIPIENT_WIRE_SELECTION = {
  accessCodeHash: false,
  otpCodeHash: false,
  signingTokenHash: false,
} as const;
