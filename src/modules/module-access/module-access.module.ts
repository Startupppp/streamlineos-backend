import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { ModuleAccessController } from "./module-access.controller";
import { ModuleAccessService } from "./module-access.service";

@Module({
  imports: [AccessModule],
  controllers: [ModuleAccessController],
  providers: [ModuleAccessService],
})
export class ModuleAccessModule {}
