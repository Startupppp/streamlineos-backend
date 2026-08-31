import { Module } from "@nestjs/common";
import { PmWorkspacesController } from "./pm-workspaces.controller";
import { PmWorkspacesService } from "./pm-workspaces.service";
import { PmWorkspaceMembershipsService } from "./pm-workspace-memberships.service";

@Module({
  controllers: [PmWorkspacesController],
  providers: [PmWorkspacesService, PmWorkspaceMembershipsService],
  exports: [PmWorkspacesService, PmWorkspaceMembershipsService],
})
export class PmWorkspacesModule {}
