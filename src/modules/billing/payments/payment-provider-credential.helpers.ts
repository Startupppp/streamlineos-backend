import { paymentProviderCredentials } from "../../../db/schema";

export function toPublicCredential(cred: typeof paymentProviderCredentials.$inferSelect) {
  return {
    environment: cred.environment,
    maskedKeyHint: cred.maskedKeyHint,
    hasSecret: !!cred.secretRef,
    hasWebhookSecret: !!cred.webhookSecretRef,
    lastRotatedAt: cred.lastRotatedAt,
  };
}
