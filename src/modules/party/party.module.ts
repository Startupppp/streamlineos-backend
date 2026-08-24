import { Module } from "@nestjs/common";
import { PartyController } from "./party.controller";
import { PartyMergeController } from "./party-merge.controller";
import { PartyService } from "./party.service";
import { PartyMergeService } from "./party-merge.service";
import { PartyRolesService } from "./party-roles.service";
import { SubjectController } from "./subject.controller";
import { SubjectService } from "./subject.service";

@Module({
  controllers: [PartyController, PartyMergeController, SubjectController],
  providers: [PartyService, PartyMergeService, PartyRolesService, SubjectService],
  exports: [PartyMergeService, PartyRolesService, SubjectService],
})
export class PartyModule {}
