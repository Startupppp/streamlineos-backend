import { Module } from "@nestjs/common";
import { RelationshipStateService } from "./relationship-state.service";

/**
 * The relationship state model.
 *
 * Deliberately shallow: it imports nothing. Everything it holds is derived from
 * `activities`, so a dependency on any other module would be a dependency on
 * something that cannot change what this module says — and the three modules
 * that DO need it (`activities`, `ingress`, `autonomy`) would then be one import
 * away from a cycle. Ownership pointing this way round is what keeps the graph
 * acyclic by construction rather than by luck.
 */
@Module({
  providers: [RelationshipStateService],
  exports: [RelationshipStateService],
})
export class RelationshipsModule {}
