import { Inject, Injectable } from "@nestjs/common";
import { forEachOrg } from "../../common/tenant";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SupportSlaService } from "../support/core/support-sla.service";
import { SupportTicketsService } from "../support/core/support-tickets.service";

@Injectable()
export class CronSupportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sla: SupportSlaService,
    private readonly tickets: SupportTicketsService,
  ) {}

  // Both delegates run cross-org queries of their own; the wrapper is what scopes them
  async runSlaEscalations(): Promise<{
    orgsProcessed: number;
    checked: number;
    escalated: number;
  }> {
    let orgsProcessed = 0;
    let checked = 0;
    let escalated = 0;

    await forEachOrg(this.db, "support-sla-escalations", async () => {
      const result = await this.sla.runEscalationsForAllOrgs();
      orgsProcessed += result.orgsProcessed;
      checked += result.checked;
      escalated += result.escalated;
    });

    return { orgsProcessed, checked, escalated };
  }

  async runUnsnooze(): Promise<{ unsnoozed: number }> {
    let unsnoozed = 0;

    await forEachOrg(this.db, "support-unsnooze", async () => {
      const result = await this.tickets.unsnoozeExpiredTickets();
      unsnoozed += result.unsnoozed;
    });

    return { unsnoozed };
  }
}
