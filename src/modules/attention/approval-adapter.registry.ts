import { Injectable } from "@nestjs/common";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../notifications/dto/unified-inbox.schemas";

export type ApprovalSourceAdapter = {
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
  ): Promise<BuildApprovalInboxItem[]>;
};

@Injectable()
export class ApprovalAdapterRegistry {
  private readonly adapters: ApprovalSourceAdapter[] = [];

  register(adapter: ApprovalSourceAdapter): void {
    const alreadyRegistered = this.adapters.some(
      (a) => a.module === adapter.module && a.kindLabel === adapter.kindLabel,
    );
    if (!alreadyRegistered) this.adapters.push(adapter);
  }

  list(): readonly ApprovalSourceAdapter[] {
    return this.adapters;
  }
}
