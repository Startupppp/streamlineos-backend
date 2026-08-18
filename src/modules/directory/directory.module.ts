import { Module } from "@nestjs/common";
import { DirectoryController } from "./directory.controller";
import { DirectoryService } from "./directory.service";
import { DirectoryIdentityService } from "./directory-identity.service";
import { WorkerEngagementsService } from "./worker-engagements.service";

@Module({
  controllers: [DirectoryController],
  providers: [DirectoryService, DirectoryIdentityService, WorkerEngagementsService],
})
export class DirectoryModule {}
