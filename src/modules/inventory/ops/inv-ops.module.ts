import { Module } from "@nestjs/common";
import { InvOpsController } from "./inv-ops.controller";
import { InvOpsService } from "./inv-ops.service";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvProjectsModule } from "../projects/inv-projects.module";

/**
 * B2. `InvStockEngineModule` supplies the warehouse scope and settings;
 * `InvProjectsModule` supplies the at-risk feed rather than this module keeping
 * a second copy of the coverage rule. Without both imports Nest cannot construct
 * the service and the application fails to boot at runtime, which typecheck
 * cannot see.
 */
@Module({
  imports: [InvStockEngineModule, InvProjectsModule],
  controllers: [InvOpsController],
  providers: [InvOpsService],
  exports: [InvOpsService],
})
export class InvOpsModule {}
