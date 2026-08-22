import { Module } from "@nestjs/common";
import { PmWorkspacesModule } from "../pm-workspaces/pm-workspaces.module";
import { TeamsController } from "./teams.controller";
import { TeamsService } from "./teams.service";

@Module({
  imports: [PmWorkspacesModule],
  controllers: [TeamsController],
  providers: [TeamsService],
})
export class BuildTeamsModule {}
