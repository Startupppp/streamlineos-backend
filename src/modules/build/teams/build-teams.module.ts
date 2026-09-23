import { Module } from "@nestjs/common";
import { TeamsController } from "./teams.controller";
import { TeamsService } from "./teams.service";
import { TeamMembersService } from "./team-members.service";
import { TeamProjectsService } from "./team-projects.service";

@Module({
  controllers: [TeamsController],
  providers: [TeamsService, TeamMembersService, TeamProjectsService],
})
export class BuildTeamsModule {}
