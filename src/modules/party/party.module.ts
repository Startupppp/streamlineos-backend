import { Module } from "@nestjs/common";
import { PartyController } from "./party.controller";
import { PartyMergeController } from "./party-merge.controller";
import { PartyService } from "./party.service";
import { PartyDivergenceService } from "./party-divergence.service";
import { PartyMergeService } from "./party-merge.service";
import { PartyRevertService } from "./party-revert.service";
import { PartyRolesService } from "./party-roles.service";
import { SubjectController } from "./subject.controller";
import { SubjectService } from "./subject.service";
import { SubjectTypeService } from "./subject-type.service";

@Module({
  controllers: [PartyController, PartyMergeController, SubjectController],
  providers: [PartyService, PartyDivergenceService, PartyMergeService, PartyRevertService, PartyRolesService, SubjectService, SubjectTypeService],
  exports: [PartyDivergenceService, PartyMergeService, PartyRevertService, PartyRolesService, SubjectService, SubjectTypeService],
})
export class PartyModule {}
