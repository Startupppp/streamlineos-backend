import { Injectable } from "@nestjs/common";
import { logger } from "../logger/logger.service";

@Injectable()
export class OutboxWakeSignal {
  private listener: (() => void) | null = null;

  register(listener: () => void): void {
    this.listener = listener;
  }

  wake(): void {
    if (!this.listener) return;
    try {
      this.listener();
    } catch (error: unknown) {
      logger.warn("[outbox-wake] listener threw synchronously", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
