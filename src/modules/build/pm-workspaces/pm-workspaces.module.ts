import { Module } from "@nestjs/common";
import { PmWorkspacesController } from "./pm-workspaces.controller";
import { PmWorkspacesService } from "./pm-workspaces.service";

@Module({
  controllers: [PmWorkspacesController],
  providers: [PmWorkspacesService],
  exports: [PmWorkspacesService],
})
export class PmWorkspacesModule {}
