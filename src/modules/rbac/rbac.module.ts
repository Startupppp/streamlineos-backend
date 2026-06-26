import { Module } from "@nestjs/common";
import { RbacController } from "./rbac.controller";
import { RolesController } from "./roles.controller";
import { RbacService } from "./rbac.service";
import { RolesService } from "./roles.service";

@Module({
  controllers: [RbacController, RolesController],
  providers: [RbacService, RolesService],
})
export class RbacModule {}
