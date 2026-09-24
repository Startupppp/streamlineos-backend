import { createHash, createHmac } from "node:crypto";
import { isRecord } from "../../../common/types/is-record";

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

export const MAX_IDEMPOTENCY_KEY_LENGTH = 120;

export const MIN_CONFIRMATION_SECRET_LENGTH = 32;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) ordered[key] = canonicalize(value[key]);
  return ordered;
}

export function stableHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

export function boundedIdempotencyKey(key: string): string {
  return key.length <= MAX_IDEMPOTENCY_KEY_LENGTH
    ? key
    : createHash("sha256").update(key).digest("hex");
}

export function derivedIdempotencyKey(
  orgId: string,
  userId: string,
  action: string,
  payloadHash: string,
): string {
  return `derived:${stableHash({ orgId, userId, action, payloadHash })}`;
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

export interface ProposalTokenSubject {
  id: number;
  orgId: string;
  userId: string;
  action: string;
  payloadHash: string;
  expiresAt: Date;
}

export function mintProposalToken(proposal: ProposalTokenSubject): ProposeResult {
  const epoch = Math.floor(proposal.expiresAt.getTime() / 1000);
  const hmac = computeHmac(
    getSecret(),
    proposal.id,
    proposal.orgId,
    proposal.userId,
    proposal.action,
    proposal.payloadHash,
    epoch,
  );
  return {
    proposalId: proposal.id,
    token: `${proposal.id}.${epoch}.${hmac}`,
    expiresAt: proposal.expiresAt,
  };
}

export function getSecret(): string {
  const configured = process.env.AI_CONFIRMATION_SECRET?.trim();
  const secret = configured && configured.length > 0
    ? configured
    : (process.env.BACKEND_JWT_SECRET?.trim() ?? "");
  if (secret.length < MIN_CONFIRMATION_SECRET_LENGTH) {
    throw new Error(
      "AI confirmation secret is missing or too short; refusing to sign a confirmable action token.",
    );
  }
  return secret;
}
