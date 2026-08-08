import { Module } from "@nestjs/common";
import { DirectoryController } from "./directory.controller";
import { DirectoryService } from "./directory.service";
import { DirectoryIdentityService } from "./directory-identity.service";

@Module({
  controllers: [DirectoryController],
  providers: [DirectoryService, DirectoryIdentityService],
})
export class DirectoryModule {}
