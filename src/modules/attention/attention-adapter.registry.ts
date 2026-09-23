import { Injectable } from "@nestjs/common";
import type {
  InboxSourcePosition,
  ModuleTaskInboxItem,
} from "../notifications/dto/unified-inbox.schemas";

export type AttentionSourceAdapter = {
  readonly module: string;
  readonly permission: string;
  readonly kindLabel: string;
  readonly supportsAfterCursor: boolean;
  fetch(
    orgId: string,
    userId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<ModuleTaskInboxItem[]>;
  countPending(
    orgId: string,
    userId: string,
    membershipId: number | null,
  ): Promise<number>;
};

export function attentionAdapterKey(
  adapter: Pick<AttentionSourceAdapter, "module" | "kindLabel">,
): string {
  return `${adapter.module}:${adapter.kindLabel}`;
}

@Injectable()
export class AttentionAdapterRegistry {
  private readonly adapters: AttentionSourceAdapter[] = [];

  register(adapter: AttentionSourceAdapter): void {
    const alreadyRegistered = this.adapters.some(
      (a) => a.module === adapter.module && a.kindLabel === adapter.kindLabel,
    );
    if (!alreadyRegistered) this.adapters.push(adapter);
  }

  list(): readonly AttentionSourceAdapter[] {
    return [...this.adapters];
  }
}
