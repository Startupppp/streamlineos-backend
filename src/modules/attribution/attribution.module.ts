import { Module } from "@nestjs/common";
import { AttributionController } from "./attribution.controller";
import { AttributionService } from "./attribution.service";

/**
 * Multi-touch attribution, phase 6 ticket 18.
 *
 * It imports nothing. That is worth stating rather than noticing: attribution is
 * a reading of two tables the platform already writes — `activities` and `deals`
 * — and it owns no store of its own, so it has no writer to depend on and no
 * derived table to keep in step. A dependency here would be a sign that a credit
 * had started being computed somewhere it could be saved.
 *
 * Exported because ticket 19's MCP surface answers `crm.attribution.report`
 * through this service rather than through its own query, which is that
 * ticket's fourth criterion: the protocol layer never reaches past the service
 * boundary.
 */
@Module({
  controllers: [AttributionController],
  providers: [AttributionService],
  exports: [AttributionService],
})
export class AttributionModule {}
