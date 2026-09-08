import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { sortByUrgency } from "./lib/service-delivery-aging";
import {
  fetchCasesForOpsInbox,
  fetchSafetyForOpsInbox,
  fetchHelpdeskForOpsInbox,
  fetchHelpdeskForMyItems,
  fetchCasesForMyItems,
} from "./service-delivery-queries";
import type { ServiceDeliveryItem } from "./lib/service-delivery-item";

export interface ServiceDeliveryOpsInbox {
  mode: "ops_unified_inbox";
  honestyNote: string;
  asOf: string;
  capabilities: {
    canViewCases: boolean;
    canViewSafety: boolean;
    canViewHelpdesk: boolean;
  };
  totals: {
    cases: number;
    safety: number;
    helpdesk: number;
    criticalAging: number;
    slaBreached: number;
  };
  items: ServiceDeliveryItem[];
}

export interface ServiceDeliveryMyItems {
  mode: "employee_self_service";
  honestyNote: string;
  items: ServiceDeliveryItem[];
  totals: { open: number };
}

/**
 * Unified HR service-delivery inbox across cases, safety, and helpdesk.
 * Respects permission boundaries; does not leak confidential case detail.
 */
@Injectable()
export class ServiceDeliveryInboxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getOpsInbox(orgId: string, userId: string, membershipId?: number | null): Promise<ServiceDeliveryOpsInbox> {
    const perms = await this.access.resolveUserPermissions(orgId, userId);
    const canViewCases = perms.has("hr:cases:view");
    const canViewSafety = perms.has("hr:safety:view");
    const canViewHelpdesk =
      perms.has("hr:helpdesk:view") || perms.has("hr:helpdesk:manage");
    const hasConfidential = perms.has("hr:cases:confidential") || perms.has("hr:sensitive:view");

    const honestyNote =
      "Unified service-delivery inbox aggregates open HR cases, safety incidents, and helpdesk tickets you are allowed to see. Confidential case bodies stay on the case detail route. SLA breach uses ticket slaDueAt when present.";

    const now = new Date();
    const items: ServiceDeliveryItem[] = [];

    if (canViewCases)
      items.push(...await fetchCasesForOpsInbox(this.db, orgId, membershipId, hasConfidential, now));
    if (canViewSafety)
      items.push(...await fetchSafetyForOpsInbox(this.db, orgId, now));
    if (canViewHelpdesk) {
      const isAdmin = perms.has("hr:helpdesk:manage");
      items.push(...await fetchHelpdeskForOpsInbox(this.db, orgId, userId, isAdmin, now));
    }

    const sorted = sortByUrgency(items).slice(0, 100);

    return {
      mode: "ops_unified_inbox",
      honestyNote,
      asOf: now.toISOString(),
      capabilities: { canViewCases, canViewSafety, canViewHelpdesk },
      totals: {
        cases: sorted.filter((i) => i.kind === "case").length,
        safety: sorted.filter((i) => i.kind === "safety_incident").length,
        helpdesk: sorted.filter((i) => i.kind === "helpdesk").length,
        criticalAging: sorted.filter((i) => i.aging.bucket === "critical").length,
        slaBreached: sorted.filter((i) => i.aging.slaBreached).length,
      },
      items: sorted,
    };
  }

  async getMyItems(orgId: string, userId: string, membershipId?: number | null): Promise<ServiceDeliveryMyItems> {
    const now = new Date();
    const items: ServiceDeliveryItem[] = [
      ...await fetchHelpdeskForMyItems(this.db, orgId, userId, now),
      ...await fetchCasesForMyItems(this.db, orgId, membershipId, now),
    ];
    const sorted = sortByUrgency(items);

    return {
      mode: "employee_self_service",
      honestyNote:
        "Your open helpdesk tickets and cases you reported. Confidential case details remain restricted on the case page.",
      items: sorted,
      totals: { open: sorted.length },
    };
  }
}
