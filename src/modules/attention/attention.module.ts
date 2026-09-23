import { Module } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "./approval-adapter.registry";

@Module({
  providers: [ApprovalAdapterRegistry],
  exports: [ApprovalAdapterRegistry],
})
export class AttentionModule {}
