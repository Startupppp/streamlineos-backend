import { Module } from "@nestjs/common";
import { DirectoryController } from "./directory.controller";
import { DirectoryService } from "./directory.service";
import { DirectoryIdentityService } from "./directory-identity.service";
import { DirectoryPersonEnsureService } from "./directory-person-ensure.service";
import { WorkerEngagementsService } from "./worker-engagements.service";
import { EmploymentFactsModule } from "./employment-facts.module";

@Module({
  imports: [EmploymentFactsModule],
  controllers: [DirectoryController],
  providers: [DirectoryService, DirectoryIdentityService, DirectoryPersonEnsureService, WorkerEngagementsService],
  exports: [EmploymentFactsModule],
})
export class DirectoryModule {}
