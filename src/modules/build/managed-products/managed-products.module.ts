import { Module } from "@nestjs/common";
import { PmWorkspacesModule } from "../pm-workspaces/pm-workspaces.module";
import { ManagedProductsController } from "./managed-products.controller";
import { ManagedProductsService } from "./managed-products.service";

@Module({
  imports: [PmWorkspacesModule],
  controllers: [ManagedProductsController],
  providers: [ManagedProductsService],
})
export class BuildManagedProductsModule {}
