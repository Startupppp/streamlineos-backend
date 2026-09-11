import { Module } from "@nestjs/common";
import { PartyModule } from "../party/party.module";
import { DataQualityController } from "./data-quality.controller";
import { DataQualityQueueService } from "./data-quality-queue.service";
import { DataQualityResolutionService } from "./data-quality-resolution.service";
import { DataQualityProducersService } from "./data-quality-producers.service";
import { DataQualityHealthService } from "./dataset-health.service";

/**
 * One queue, many producers.
 *
 * Phase 1 detects duplicates and files them in `party_duplicate_candidates`, and
 * `crm/metadata/crm-data-quality.service.ts` counts eight other problems into a
 * dashboard. Neither is work: nothing carries an owner, an age, or a record of
 * what was decided. This module is the queue those become — and it deliberately
 * absorbs neither of them yet, because the standing report reads the legacy
 * `leads`/`crm_organizations` tables that Phase 2's party consolidation is still
 * migrating. Retiring it belongs with that migration, not ahead of it.
 *
 * It owns no detector. The duplicate producer reads what `assessDuplicate`
 * already concluded, and the reachability producer asks the email module about
 * suppression rather than re-deriving deliverability — because two answers to
 * "are these the same company" that can disagree is worse than one answer that
 * is sometimes wrong.
 *
 * `DataQualityHealthService` is exported because the dataset's health belongs on
 * Phase 1's autonomy scoreboard rather than on a surface of its own — a tenant
 * has one place it goes to ask "is this working", and a second scoreboard would
 * split that habit in two. Exporting one small read-and-record service is what
 * lets `AutonomyModule` show the number without acquiring the queue's cursors,
 * its resolution machinery or its merge executor.
 *
 * `PartyModule` is imported for `PartyMergeService`: merging is the one proposed
 * action with an executor, and it has one because `party_merges` snapshots both
 * rows, which is what makes the reversibility class this queue records true.
 * `EmailSuppressionService` needs no import — `EmailModule` is `@Global`.
 */
@Module({
  imports: [PartyModule],
  controllers: [DataQualityController],
  providers: [
    DataQualityQueueService,
    DataQualityResolutionService,
    DataQualityProducersService,
    DataQualityHealthService,
  ],
  exports: [DataQualityProducersService, DataQualityHealthService],
})
export class DataQualityModule {}
