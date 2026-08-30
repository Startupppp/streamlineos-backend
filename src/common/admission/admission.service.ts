import { Injectable } from "@nestjs/common";
import type { AdmissionConfig } from "./admission.config";
import { isReserved, NUM_SHEDDABLE_RANKS, shedRank, type WorkClass } from "./work-class";

export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; retryAfterSeconds: number };

export interface AdmissionSnapshot {
  inFlight: number;
  maxConcurrent: number;
  orgMapSize: number;
}

@Injectable()
export class AdmissionService {
  private inFlight = 0;
  private readonly orgInFlight = new Map<string, number>();

  constructor(private readonly config: AdmissionConfig) {}

  tryAdmit(workClass: WorkClass, orgId: string): AdmissionDecision {
    if (!this.config.enabled) return { admitted: true };

    const { maxQueueDepth, orgMaxConcurrent } = this.config;

    if (this.inFlight >= maxQueueDepth)
      return { admitted: false, retryAfterSeconds: this.retryAfterSeconds() };

    if (isReserved(workClass)) {
      this.increment(orgId);
      return { admitted: true };
    }

    const threshold = this.sheddingThreshold(shedRank(workClass));
    if (this.inFlight >= threshold)
      return { admitted: false, retryAfterSeconds: this.retryAfterSeconds() };

    const orgCount = this.orgInFlight.get(orgId) ?? 0;
    if (orgCount >= orgMaxConcurrent)
      return { admitted: false, retryAfterSeconds: this.retryAfterSeconds() };

    this.increment(orgId);
    return { admitted: true };
  }

  release(orgId: string): void {
    if (!this.config.enabled) return;
    const orgCount = this.orgInFlight.get(orgId);
    if (orgCount === undefined) return;

    this.inFlight = Math.max(0, this.inFlight - 1);
    if (orgCount <= 1)
      this.orgInFlight.delete(orgId);
    else
      this.orgInFlight.set(orgId, orgCount - 1);
  }

  snapshot(): AdmissionSnapshot {
    return {
      inFlight: this.inFlight,
      maxConcurrent: this.config.maxConcurrent,
      orgMapSize: this.orgInFlight.size,
    };
  }

  private increment(orgId: string): void {
    this.inFlight += 1;
    this.orgInFlight.set(orgId, (this.orgInFlight.get(orgId) ?? 0) + 1);
  }

  private sheddingThreshold(rank: number): number {
    const sheddableCapacity = Math.floor(
      this.config.maxConcurrent * (1 - this.config.reservedFraction),
    );
    return Math.floor((sheddableCapacity * (rank + 1)) / NUM_SHEDDABLE_RANKS);
  }

  private retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.config.maxExecutionMs / 5_000));
  }
}
