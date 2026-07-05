import { Module } from "@nestjs/common";
import { InvTraceabilityController } from "./inv-traceability.controller";
import { InvTraceabilityService } from "./inv-traceability.service";
import { TraceabilityChainService } from "./traceability-chain.service";

@Module({
  controllers: [InvTraceabilityController],
  providers: [InvTraceabilityService, TraceabilityChainService],
  exports: [InvTraceabilityService, TraceabilityChainService],
})
export class InvTraceabilityModule {}
