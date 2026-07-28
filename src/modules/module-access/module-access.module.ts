import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { ModuleAccessController } from "./module-access.controller";
import { ModuleAccessService } from "./module-access.service";
import { ModuleAccessGroupsService } from "./module-access-groups.service";

@Module({
  imports: [AccessModule],
  controllers: [ModuleAccessController],
  providers: [ModuleAccessService, ModuleAccessGroupsService],
})
export class ModuleAccessModule {}
