import { Injectable, Inject } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { commandFences } from "../../db/schema";
import { IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS } from "./idempotency.constants";

export interface ClaimParams {
  orgId: string;
  audience: string;
  idempotencyKey: string;
  commandName: string;
  requestHash: string;
  principalId: string;
}

export type ClaimResult =
  | { kind: "proceed"; fenceId: number }
  | { kind: "replay"; responseBody: unknown; responseStatus: number }
  | { kind: "inflight" }
  | { kind: "mismatch" };

export interface CommandFenceStore {
  claim(params: ClaimParams): Promise<ClaimResult>;
  complete(fenceId: number, responseStatus: number, data: unknown): Promise<void>;
  fail(fenceId: number): Promise<void>;
}

export const COMMAND_FENCE_STORE = "COMMAND_FENCE_STORE";

@Injectable()
export class DrizzleCommandFenceStore implements CommandFenceStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async claim(params: ClaimParams): Promise<ClaimResult> {
    const now = Date.now();
    const leaseExpiresAt = new Date(now + IDEMPOTENCY_LEASE_MS);
    const expiresAt = new Date(now + IDEMPOTENCY_TTL_MS);

    const inserted = await this.db
      .insert(commandFences)
      .values({
        organizationId: params.orgId,
        audience: params.audience,
        idempotencyKey: params.idempotencyKey,
        commandName: params.commandName,
        requestHash: params.requestHash,
        principalId: params.principalId,
        status: "IN_FLIGHT",
        leaseExpiresAt,
        expiresAt,
      })
      .onConflictDoNothing({
        target: [
          commandFences.organizationId,
          commandFences.audience,
          commandFences.idempotencyKey,
        ],
      })
      .returning({ fenceId: commandFences.commandFenceId });

    const [firstInserted] = inserted;
    if (firstInserted) return { kind: "proceed", fenceId: firstInserted.fenceId };

    const [existing] = await this.db
      .select()
      .from(commandFences)
      .where(
        and(
          eq(commandFences.organizationId, params.orgId),
          eq(commandFences.audience, params.audience),
          eq(commandFences.idempotencyKey, params.idempotencyKey),
        ),
      )
      .limit(1);

    if (!existing) return { kind: "inflight" };

    if (existing.status === "COMPLETED") {
      if (existing.requestHash !== params.requestHash) return { kind: "mismatch" };
      return {
        kind: "replay",
        responseBody: existing.responseBody ?? null,
        responseStatus: existing.responseStatus ?? 200,
      };
    }

    if (existing.status === "IN_FLIGHT" && existing.leaseExpiresAt.getTime() > now) {
      if (existing.requestHash !== params.requestHash) return { kind: "mismatch" };
      return { kind: "inflight" };
    }

    const reclaimed = await this.db
      .update(commandFences)
      .set({
        status: "IN_FLIGHT",
        leaseExpiresAt,
        expiresAt,
        requestHash: params.requestHash,
        principalId: params.principalId,
        responseBody: null,
        responseStatus: null,
      })
      .where(
        and(
          eq(commandFences.commandFenceId, existing.commandFenceId),
          eq(commandFences.leaseExpiresAt, existing.leaseExpiresAt),
        ),
      )
      .returning({ fenceId: commandFences.commandFenceId });

    const [firstReclaimed] = reclaimed;
    if (firstReclaimed) return { kind: "proceed", fenceId: firstReclaimed.fenceId };
    return { kind: "inflight" };
  }

  async complete(fenceId: number, responseStatus: number, data: unknown): Promise<void> {
    try {
      await this.db
        .update(commandFences)
        .set({ status: "COMPLETED", responseBody: data ?? null, responseStatus })
        .where(eq(commandFences.commandFenceId, fenceId));
    } catch {
      // best-effort: a lost completion write just means the next retry re-executes after the lease.
    }
  }

  async fail(fenceId: number): Promise<void> {
    try {
      await this.db
        .update(commandFences)
        .set({ status: "FAILED" })
        .where(eq(commandFences.commandFenceId, fenceId));
    } catch {
      // best-effort
    }
  }
}

interface FenceRecord {
  fenceId: number;
  requestHash: string;
  status: "IN_FLIGHT" | "COMPLETED" | "FAILED";
  leaseExpiresAt: Date;
  responseBody: unknown;
  responseStatus: number | null;
}

export class InMemoryCommandFenceStore implements CommandFenceStore {
  private nextId = 1;
  private readonly fences = new Map<string, FenceRecord>();

  private static key(
    params: Pick<ClaimParams, "orgId" | "audience" | "idempotencyKey">,
  ): string {
    return `${params.orgId}|${params.audience}|${params.idempotencyKey}`;
  }

  async claim(params: ClaimParams): Promise<ClaimResult> {
    const k = InMemoryCommandFenceStore.key(params);
    const now = Date.now();
    const existing = this.fences.get(k);

    if (!existing) {
      const fenceId = this.nextId++;
      this.fences.set(k, {
        fenceId,
        requestHash: params.requestHash,
        status: "IN_FLIGHT",
        leaseExpiresAt: new Date(now + IDEMPOTENCY_LEASE_MS),
        responseBody: null,
        responseStatus: null,
      });
      return { kind: "proceed", fenceId };
    }

    if (existing.status === "COMPLETED") {
      if (existing.requestHash !== params.requestHash) return { kind: "mismatch" };
      return {
        kind: "replay",
        responseBody: existing.responseBody,
        responseStatus: existing.responseStatus ?? 200,
      };
    }

    if (existing.status === "IN_FLIGHT" && existing.leaseExpiresAt.getTime() > now) {
      if (existing.requestHash !== params.requestHash) return { kind: "mismatch" };
      return { kind: "inflight" };
    }

    const { fenceId } = existing;
    this.fences.set(k, {
      fenceId,
      requestHash: params.requestHash,
      status: "IN_FLIGHT",
      leaseExpiresAt: new Date(now + IDEMPOTENCY_LEASE_MS),
      responseBody: null,
      responseStatus: null,
    });
    return { kind: "proceed", fenceId };
  }

  async complete(fenceId: number, responseStatus: number, data: unknown): Promise<void> {
    for (const [k, fence] of this.fences.entries()) {
      if (fence.fenceId === fenceId) {
        this.fences.set(k, { ...fence, status: "COMPLETED", responseBody: data, responseStatus });
        return;
      }
    }
  }

  async fail(fenceId: number): Promise<void> {
    for (const [k, fence] of this.fences.entries()) {
      if (fence.fenceId === fenceId) {
        this.fences.set(k, { ...fence, status: "FAILED" });
        return;
      }
    }
  }
}
