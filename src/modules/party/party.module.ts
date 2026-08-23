import { Module } from "@nestjs/common";
import { PartyController } from "./party.controller";
import { PartyMergeController } from "./party-merge.controller";
import { PartyService } from "./party.service";
import { PartyMergeService } from "./party-merge.service";
import { PartyRolesService } from "./party-roles.service";

@Module({
  controllers: [PartyController, PartyMergeController],
  providers: [PartyService, PartyMergeService, PartyRolesService],
  exports: [PartyMergeService, PartyRolesService],
})
export class PartyModule {}
