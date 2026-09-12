import type { Logger } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import type { RepairClass } from "../../db/schema/crm/autonomy-repairs";
import type { DataQualityQueueService } from "../data-quality/data-quality-queue.service";
import type { SwitchDecision } from "./kill-switch";

/** What one class's pass concluded, whether or not it changed anything. */
export interface ClassOutcome {
  readonly repairClass: RepairClass;
  readonly considered: number;
  readonly repaired: number;
  readonly refused: number;
  readonly failed: number;
  readonly autonomousDecisionId: string | null;
  readonly outcome: "applied" | "skipped";
  readonly explanation: string | null;
}

export interface RepairDraft {
  readonly findingId: string;
  readonly partyId: string;
  readonly field: "email" | "phone";
  readonly previousValue: string;
  readonly repairedValue: string;
}

/** The kill switch and this tenant's grants, read once per run and shared by every class. */
export interface RepairRunContext {
  autonomySwitch: SwitchDecision;
  policies: { repairClass: string; enabled: boolean }[];
}

/**
 * What `AutonomyRepairService` hands its libs in place of `this`.
 *
 * `db` is the request transaction, the same handle `this.db` is, so a lib's
 * writes commit or roll back with the request exactly as they did as methods.
 * `logger` keeps the `AutonomyRepair` context on every line the libs write.
 */
export interface RepairDeps {
  readonly db: Db;
  readonly queue: DataQualityQueueService;
  readonly logger: Logger;
}
