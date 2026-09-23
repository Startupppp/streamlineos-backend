import { Module } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "./approval-adapter.registry";
import { AttentionAdapterRegistry } from "./attention-adapter.registry";

@Module({
  providers: [ApprovalAdapterRegistry, AttentionAdapterRegistry],
  exports: [ApprovalAdapterRegistry, AttentionAdapterRegistry],
})
export class AttentionModule {}
