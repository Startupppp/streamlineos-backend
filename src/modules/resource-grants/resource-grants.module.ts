import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../db/drizzle.module";
import { ResourceGrantsController } from "./resource-grants.controller";
import { ResourceGrantsService } from "./resource-grants.service";

@Module({
  imports: [DrizzleModule],
  controllers: [ResourceGrantsController],
  providers: [ResourceGrantsService],
  exports: [ResourceGrantsService],
})
export class ResourceGrantsModule {}
