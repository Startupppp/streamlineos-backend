import { Injectable } from "@nestjs/common";
import { SupportSlaService } from "../support/core/support-sla.service";
import { SupportTicketsService } from "../support/core/support-tickets.service";

@Injectable()
export class CronSupportService {
  constructor(
    private readonly sla: SupportSlaService,
    private readonly tickets: SupportTicketsService,
  ) {}

  runSlaEscalations(): Promise<{ orgsProcessed: number; checked: number; escalated: number }> {
    return this.sla.runEscalationsForAllOrgs();
  }

  runUnsnooze(): Promise<{ unsnoozed: number }> {
    return this.tickets.unsnoozeExpiredTickets();
  }
}
