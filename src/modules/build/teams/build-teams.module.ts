import { Module } from "@nestjs/common";
import { PmWorkspacesModule } from "../pm-workspaces/pm-workspaces.module";
import { TeamsController } from "./teams.controller";
import { TeamsService } from "./teams.service";
import { TeamMembersService } from "./team-members.service";
import { TeamProjectsService } from "./team-projects.service";

@Module({
  imports: [PmWorkspacesModule],
  controllers: [TeamsController],
  providers: [TeamsService, TeamMembersService, TeamProjectsService],
  exports: [TeamsService],
})
export class BuildTeamsModule {}
