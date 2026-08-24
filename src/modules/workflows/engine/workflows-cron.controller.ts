import { Controller, Headers, Post } from "@nestjs/common";
import { Public } from "../../../common/auth/public.decorator";
import { assertCronSecret } from "../../cron/cron-secret";
import {
  WorkflowRunnerService,
  type WorkflowSweepResult,
} from "./workflow-runner.service";

@Public()
@Controller("cron")
export class WorkflowsCronController {
  constructor(private readonly runner: WorkflowRunnerService) {}

  @Post("workflow-executions-sweep")
  sweep(
    @Headers("authorization") authorization: string | undefined,
  ): Promise<WorkflowSweepResult> {
    assertCronSecret(authorization);
    return this.runner.sweep();
  }
}
