import { BadRequestException, ConflictException, UnprocessableEntityException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { CommandFenceStore } from "../../../../common/idempotency/command-fence-store";
import { aiStreamCommandRecordSchema } from "./ai-stream-command.schemas";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(Reflect.get(value, key))]));
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export async function claimAiStreamCommand(store: CommandFenceStore, input: {
  key: unknown; command: string; orgId: string; userId: string; membershipId: number;
  audience: string; body: unknown;
}): Promise<{ kind: "proceed"; fenceId: number } | { kind: "replay"; data: unknown }> {
  const key = typeof input.key === "string" ? input.key.trim() : "";
  if (!key || key.length > 200) throw new BadRequestException("A valid Idempotency-Key of at most 200 characters is required");
  const claim = await store.claim({
    orgId: input.orgId, audience: input.audience,
    idempotencyKey: hash([input.command, key]), commandName: input.command,
    principalId: input.userId,
    requestHash: hash({ command: input.command, userId: input.userId, membershipId: input.membershipId, body: input.body }),
  });
  if (claim.kind === "mismatch") throw new UnprocessableEntityException("This Idempotency-Key belongs to a different request or caller");
  if (claim.kind === "inflight") throw new ConflictException("This AI operation is already in progress");
  if (claim.kind === "replay") {
    const record = aiStreamCommandRecordSchema.parse(claim.responseBody);
    if (record.state === "started") throw new ConflictException("This AI attempt already started; use a new key to regenerate intentionally");
    return { kind: "replay", data: record.data };
  }
  await store.complete(claim.fenceId, 200, { state: "started" }, input.orgId);
  return claim;
}

export function completeAiStreamCommand(store: CommandFenceStore, fenceId: number, orgId: string, data: unknown): Promise<void> {
  return store.complete(fenceId, 200, { state: "completed", data }, orgId);
}
