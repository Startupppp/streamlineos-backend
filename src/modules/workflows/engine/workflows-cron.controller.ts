import { Controller, Headers, Post } from "@nestjs/common";
import { Public } from "../../../common/auth/public.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { assertCronSecret } from "../../cron/cron-secret";
import { CronLeaseService } from "../../cron/cron-lease.service";
import {
  WorkflowRunnerService,
  type WorkflowSweepResult,
} from "./workflow-runner.service";
import {
  WorkflowScheduleTickService,
  type SchedulesTickResult,
} from "./workflow-schedule-tick.service";

const SCHEDULES_TICK_WINDOW_SECONDS = 55;

@Public()
@Controller("cron")
export class WorkflowsCronController {
  constructor(
    private readonly runner: WorkflowRunnerService,
    private readonly scheduleTick: WorkflowScheduleTickService,
    private readonly lease: CronLeaseService,
  ) {}

  @Post("workflow-executions-sweep")
  @BodylessAction()
  sweep(
    @Headers("authorization") authorization: string | undefined,
  ): Promise<WorkflowSweepResult> {
    assertCronSecret(authorization);
    return this.runner.sweep();
  }

  @Post("workflow-schedules-tick")
  @BodylessAction()
  async schedulesTick(
    @Headers("authorization") authorization: string | undefined,
  ): Promise<SchedulesTickResult | { skipped: true }> {
    assertCronSecret(authorization);
    const outcome = await this.lease.withLease(
      "workflow-schedules-tick",
      SCHEDULES_TICK_WINDOW_SECONDS,
      () => this.scheduleTick.schedulesTick(),
    );
    if (!outcome.ran) return { skipped: true };
    return outcome.result;
  }
}
