import { Injectable } from "@nestjs/common";
import { SupportSlaService } from "../support/support-sla.service";
import { SupportTicketsService } from "../support/support-tickets.service";

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
