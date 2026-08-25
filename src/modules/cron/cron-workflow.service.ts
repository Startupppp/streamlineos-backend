import { Injectable, Logger } from "@nestjs/common";
import {
  WorkflowOutboxRelayService,
  WorkflowRunnerService,
  type DrainResult,
  type RelayResult,
} from "../../common/workflow";

/**
 * Drives the durable workflow runtime.
 *
 * The two halves run in order on purpose: relaying first means an event
 * committed a moment ago becomes a run that this same tick can execute, rather
 * than waiting a full interval to start.
 *
 * Neither service schedules itself. Keeping the cadence here means one place
 * decides how often background work runs, instead of timers hidden inside
 * services where nobody finds them.
 */
@Injectable()
export class CronWorkflowService {
  private readonly logger = new Logger(CronWorkflowService.name);

  constructor(
    private readonly relayService: WorkflowOutboxRelayService,
    private readonly runner: WorkflowRunnerService,
  ) {}

  async tick(): Promise<{ relay: RelayResult; drain: DrainResult }> {
    const relay = await this.relayService.relay();
    const drain = await this.runner.drain();

    if (relay.started > 0 || drain.claimed > 0)
      this.logger.log(
        `Workflow tick — relayed ${String(relay.started)}, drained ${String(drain.claimed)}`,
      );

    return { relay, drain };
  }
}
