import { createHash, createHmac } from "node:crypto";

export interface ProposeInput {
  orgId: string;
  userId: string;
  action: string;
  payload: Record<string, unknown>;
  ttlSeconds?: number;
  idempotencyKey?: string;
}

export interface ProposeResult {
  proposalId: number;
  token: string;
  expiresAt: Date;
}

export interface ConfirmInput {
  token: string;
  actor: { orgId: string; userId: string };
}

export interface ConfirmResult {
  proposalId: number;
  action: string;
  payload: Record<string, unknown>;
}

export const MAX_TTL = 300;
export const DEFAULT_TTL = 120;

export function stableHash(payload: Record<string, unknown>): string {
  const sorted = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(sorted).digest("hex");
}

export function computeHmac(
  secret: string,
  proposalId: number,
  orgId: string,
  userId: string,
  action: string,
  payloadHash: string,
  expiresAtEpoch: number,
): string {
  const data = `${proposalId}:${orgId}:${userId}:${action}:${payloadHash}:${expiresAtEpoch}`;
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function getSecret(): string {
  return process.env.AI_CONFIRMATION_SECRET ?? process.env.BACKEND_JWT_SECRET ?? "";
}
