import { randomBytes } from "crypto";
import { appUrl } from "../../email/app-url";

export function generateWebhookSecret(): string {
  return randomBytes(30).toString("base64url").slice(0, 40);
}

export function maskSecret(secret: string): string {
  if (secret.length <= 4) return "••••";
  return `${secret.slice(0, 4)}${"•".repeat(8)}`;
}

export function gitWebhookUrl(connectionId: number): string {
  return `${appUrl()}/api/integrations/git/webhook?connectionId=${connectionId}`;
}
