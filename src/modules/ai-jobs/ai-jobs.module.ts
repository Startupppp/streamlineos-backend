import { Module } from "@nestjs/common";
import { AiJobsService } from "./ai-jobs.service";
import { AiJobsWorkerService } from "./ai-jobs-worker.service";
import { AiJobHandlerRegistry } from "./ai-job-handler";

@Module({
  providers: [AiJobsService, AiJobsWorkerService, AiJobHandlerRegistry],
  exports: [AiJobsService, AiJobsWorkerService, AiJobHandlerRegistry],
})
export class AiJobsModule {}
