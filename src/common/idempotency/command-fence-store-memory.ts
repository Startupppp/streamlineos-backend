import { IDEMPOTENCY_LEASE_MS } from "./idempotency.constants";
import {
  requestHashMatches,
  type ClaimParams,
  type ClaimResult,
  type CommandFenceStore,
} from "./command-fence-store";

interface FenceRecord {
  fenceId: number;
  requestHash: string;
  status: "IN_FLIGHT" | "COMPLETED" | "FAILED";
  leaseExpiresAt: Date;
  createdAt: Date;
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
        createdAt: new Date(now),
        responseBody: null,
        responseStatus: null,
      });
      return { kind: "proceed", fenceId };
    }

    if (existing.status === "COMPLETED") {
      if (!requestHashMatches(existing, params)) return { kind: "mismatch" };
      return {
        kind: "replay",
        responseBody: existing.responseBody,
        responseStatus: existing.responseStatus ?? 200,
      };
    }

    if (existing.status === "IN_FLIGHT" && existing.leaseExpiresAt.getTime() > now) {
      if (!requestHashMatches(existing, params)) return { kind: "mismatch" };
      return { kind: "inflight" };
    }

    const { fenceId, createdAt } = existing;
    this.fences.set(k, {
      fenceId,
      requestHash: params.requestHash,
      status: "IN_FLIGHT",
      leaseExpiresAt: new Date(now + IDEMPOTENCY_LEASE_MS),
      createdAt,
      responseBody: null,
      responseStatus: null,
    });
    return { kind: "proceed", fenceId };
  }

  async complete(
    fenceId: number,
    responseStatus: number,
    data: unknown,
    _orgId: string,
  ): Promise<void> {
    for (const [k, fence] of this.fences.entries()) {
      if (fence.fenceId === fenceId) {
        this.fences.set(k, { ...fence, status: "COMPLETED", responseBody: data, responseStatus });
        return;
      }
    }
  }

  async fail(fenceId: number, _orgId: string): Promise<void> {
    for (const [k, fence] of this.fences.entries()) {
      if (fence.fenceId === fenceId) {
        this.fences.set(k, { ...fence, status: "FAILED" });
        return;
      }
    }
  }

  /** Test seam: expire a lease without waiting out {@link IDEMPOTENCY_LEASE_MS}. */
  expireLease(params: Pick<ClaimParams, "orgId" | "audience" | "idempotencyKey">): void {
    const k = InMemoryCommandFenceStore.key(params);
    const fence = this.fences.get(k);
    if (fence) this.fences.set(k, { ...fence, leaseExpiresAt: new Date(0) });
  }
}
