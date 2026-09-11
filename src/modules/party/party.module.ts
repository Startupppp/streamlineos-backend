import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/core/billing.module";
import { PartyController } from "./party.controller";
import { PartyMergeController } from "./party-merge.controller";
import { PartyService } from "./party.service";
import { PartyMergeService } from "./party-merge.service";
import { PartyRevertService } from "./party-revert.service";
import { PartyRolesService } from "./party-roles.service";
import { SubjectController } from "./subject.controller";
import { SubjectService } from "./subject.service";
import { SubjectTypeService } from "./subject-type.service";

@Module({
  imports: [BillingModule],
  controllers: [PartyController, PartyMergeController, SubjectController],
  providers: [PartyService, PartyMergeService, PartyRevertService, PartyRolesService, SubjectService, SubjectTypeService],
  /**
   * `PartyService` is exported because `CrmMcpModule` injects it.
   *
   * It was the one service here that stayed internal, which was true right up
   * until the MCP server was written against it. Without the export `AppModule`
   * does not instantiate at all — not the MCP route, the whole application — and
   * no unit test can see that, because every one of them builds its own module
   * with its own providers. Only booting the real graph catches it.
   *
   * The rest is the verified-consumer set: `PartyMergeService` (CRM, leads,
   * data quality) and `PartyRolesService` (data quality). Revert and the two
   * subject services are only ever reached through this module's controllers.
   */
  exports: [PartyService, PartyMergeService, PartyRolesService],
})
export class PartyModule {}
