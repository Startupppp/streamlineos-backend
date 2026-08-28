import { Module } from "@nestjs/common";
import { DirectoryController } from "./directory.controller";
import { DirectoryService } from "./directory.service";
import { DirectoryIdentityService } from "./directory-identity.service";
import { WorkerEngagementsService } from "./worker-engagements.service";
import { EmploymentFactsModule } from "./employment-facts.module";

@Module({
  imports: [EmploymentFactsModule],
  controllers: [DirectoryController],
  providers: [DirectoryService, DirectoryIdentityService, WorkerEngagementsService],
  exports: [EmploymentFactsModule],
})
export class DirectoryModule {}
