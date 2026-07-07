import { Injectable } from "@nestjs/common";
import { SupportSlaService } from "../support/support-sla.service";

@Injectable()
export class CronSupportService {
  constructor(private readonly sla: SupportSlaService) {}

  runSlaEscalations(): Promise<{ orgsProcessed: number; checked: number; escalated: number }> {
    return this.sla.runEscalationsForAllOrgs();
  }
}
