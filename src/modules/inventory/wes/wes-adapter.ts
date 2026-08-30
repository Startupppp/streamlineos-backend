import { Injectable, Logger } from "@nestjs/common";

/**
 * NEO-13 - the boundary a warehouse-execution system would sit behind.
 *
 * ## What this is, plainly
 *
 * **There is no robot, no conveyor, no put-wall and no goods-to-person station.**
 * This is an interface and a no-op implementation. Nothing here talks to
 * anything, and the work order says so in as many words: "no fake robotics".
 *
 * That is a deliberate choice rather than an unfinished one. A WES adapter that
 * *pretended* to dispatch work - queueing tasks into a table nobody drains,
 * reporting "sent to the robot" - would be worse than nothing: it would read as a
 * working integration on a demo, and the first real deployment would find out at
 * the worst moment. `docs/inventory-final-handoff.md` is a record of what that
 * failure costs. An honest boundary says exactly what it can do, which today is
 * "record that we would have dispatched this".
 *
 * ## What it is for
 *
 * Two things. It fixes the *shape* of the call - a task, an acknowledgement -
 * so a real adapter is a new class rather than a change to the picking path. And
 * it makes the picking path's obligation explicit: notifying automation is
 * best-effort, and **a failure here never fails the pick**. A picker whose
 * confirmation was rejected because a conveyor did not answer would rightly stop
 * trusting the device, and the units have already moved.
 *
 * ## What a real adapter must not do
 *
 * Write stock. A WES tells machinery where to move things; the ledger records
 * what moved, and `StockEngineService` is the only thing that writes it. This
 * file imports no engine and no Drizzle, which is what keeps that true by
 * construction rather than by care - the same argument `channel-adapter.ts`
 * makes for snapshots.
 */

export type WesTaskKind = "PICK" | "PUTAWAY" | "REPLENISH" | "MOVE";

export interface WesTask {
  /** Ours, not theirs: the id we will recognise an acknowledgement by. */
  taskRef: string;
  kind: WesTaskKind;
  warehouseId: number;
  productVariantId: number;
  fromLocationCode: string | null;
  toLocationCode: string | null;
  /** A decimal string. Quantities do not become floats crossing this boundary either. */
  quantity: string;
}

export interface WesAck {
  taskRef: string;
  accepted: boolean;
  /** The provider's own id, when it gives one. Never used as a key by us. */
  externalRef?: string;
  reason?: string;
}

export interface WesAdapter {
  readonly name: string;
  /** True when this adapter can actually reach something. The noop says false. */
  readonly isLive: boolean;
  assignTask(task: WesTask): Promise<WesAck>;
  ack(taskRef: string): Promise<WesAck>;
}

/**
 * The only implementation there is.
 *
 * It logs at debug and returns `accepted: false` with a reason that says what it
 * is. Returning `true` would be the lie this whole file exists to avoid: a caller
 * that believed it would report "dispatched" to an operator standing beside a
 * conveyor that never moved.
 */
@Injectable()
export class NoopWesAdapter implements WesAdapter {
  readonly name = "noop";
  readonly isLive = false;

  private readonly logger = new Logger(NoopWesAdapter.name);

  async assignTask(task: WesTask): Promise<WesAck> {
    this.logger.debug(
      `WES noop: would assign ${task.kind} ${task.taskRef} (${task.quantity} of variant ${task.productVariantId})`,
    );
    return {
      taskRef: task.taskRef,
      accepted: false,
      reason: "No warehouse-execution system is connected; this task was not dispatched",
    };
  }

  async ack(taskRef: string): Promise<WesAck> {
    return {
      taskRef,
      accepted: false,
      reason: "No warehouse-execution system is connected",
    };
  }
}

/**
 * Notify an adapter without letting it break the command that called it.
 *
 * The whole contract in one function, so no caller has to remember it: an
 * adapter that throws, hangs or refuses leaves the pick exactly as it was. The
 * error is swallowed *and logged*, because a swallowed failure nobody can see is
 * how the next outage becomes invisible (backend/CLAUDE.md S4).
 */
export async function notifyWes(
  adapter: WesAdapter,
  task: WesTask,
  logger: Logger,
): Promise<WesAck | null> {
  try {
    return await adapter.assignTask(task);
  } catch (error) {
    logger.warn(
      `WES adapter ${adapter.name} failed for task ${task.taskRef}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
