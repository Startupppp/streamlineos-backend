import { Module } from "@nestjs/common";
import { ScopeDirectoryController } from "./scope-directory.controller";
import { ScopeDirectoryService } from "./scope-directory.service";

@Module({
  controllers: [ScopeDirectoryController],
  providers: [ScopeDirectoryService],
  exports: [ScopeDirectoryService],
})
export class ScopeDirectoryModule {}
