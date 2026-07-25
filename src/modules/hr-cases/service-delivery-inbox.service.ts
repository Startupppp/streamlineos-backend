import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrCases } from "../../db/schema/hr/cases";
import { hrSafetyIncidents } from "../../db/schema/hr/safety";
import { helpdeskTickets } from "../../db/schema";
import { AccessService } from "../access/access.service";
import {
  classifyAging,
  severityRank,
  sortByUrgency,
  type AgingResult,
} from "./lib/service-delivery-aging";

export type ServiceDeliveryKind = "case" | "safety_incident" | "helpdesk";

export interface ServiceDeliveryItem {
  kind: ServiceDeliveryKind;
  id: number;
  ref: string;
  title: string;
  status: string;
  severity: string | null;
  assignedTo: string | null;
  href: string;
  createdAt: string;
  aging: AgingResult;
  severityRank: number;
  confidential?: boolean;
}

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

  async getOpsInbox(orgId: string, userId: string): Promise<ServiceDeliveryOpsInbox> {
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

    if (canViewCases) {
      const caseConditions = [
        eq(hrCases.orgId, orgId),
        isNull(hrCases.deletedAt),
        inArray(hrCases.status, ["open", "under_investigation"]),
      ];
      if (!hasConfidential) {
        const vis = or(eq(hrCases.confidential, false), eq(hrCases.assignedTo, userId));
        if (vis) caseConditions.push(vis);
      }
      const rows = await this.db
        .select({
          id: hrCases.id,
          caseNumber: hrCases.caseNumber,
          summary: hrCases.summary,
          status: hrCases.status,
          severity: hrCases.severity,
          assignedTo: hrCases.assignedTo,
          confidential: hrCases.confidential,
          createdAt: hrCases.createdAt,
        })
        .from(hrCases)
        .where(and(...caseConditions))
        .orderBy(desc(hrCases.createdAt))
        .limit(50);

      for (const r of rows) {
        const aging = classifyAging(r.createdAt, now);
        items.push({
          kind: "case",
          id: r.id,
          ref: r.caseNumber,
          title: r.confidential && !hasConfidential ? "Confidential case" : r.summary,
          status: r.status,
          severity: r.severity,
          assignedTo: r.assignedTo,
          href: `/hr/cases?id=${r.id}`,
          createdAt: r.createdAt.toISOString(),
          aging,
          severityRank: severityRank("case", r.severity),
          confidential: r.confidential,
        });
      }
    }

    if (canViewSafety) {
      const rows = await this.db
        .select({
          id: hrSafetyIncidents.id,
          incidentNumber: hrSafetyIncidents.incidentNumber,
          type: hrSafetyIncidents.type,
          status: hrSafetyIncidents.status,
          severity: hrSafetyIncidents.severity,
          location: hrSafetyIncidents.location,
          createdAt: hrSafetyIncidents.createdAt,
        })
        .from(hrSafetyIncidents)
        .where(
          and(
            eq(hrSafetyIncidents.orgId, orgId),
            isNull(hrSafetyIncidents.deletedAt),
            ne(hrSafetyIncidents.status, "closed"),
          ),
        )
        .orderBy(desc(hrSafetyIncidents.createdAt))
        .limit(50);

      for (const r of rows) {
        const aging = classifyAging(r.createdAt, now);
        items.push({
          kind: "safety_incident",
          id: r.id,
          ref: r.incidentNumber,
          title: `${r.type}${r.location ? ` @ ${r.location}` : ""}`,
          status: r.status,
          severity: r.severity,
          assignedTo: null,
          href: `/hr/safety?id=${r.id}`,
          createdAt: r.createdAt.toISOString(),
          aging,
          severityRank: severityRank("safety", r.severity),
        });
      }
    }

    if (canViewHelpdesk) {
      const isAdmin = perms.has("hr:helpdesk:manage");
      // ticket_status: TODO | IN_PROGRESS | IN_REVIEW | DONE
      const rows = await this.db
        .select({
          id: helpdeskTickets.id,
          title: helpdeskTickets.title,
          status: helpdeskTickets.status,
          priority: helpdeskTickets.priority,
          assigneeId: helpdeskTickets.assigneeId,
          slaDueAt: helpdeskTickets.slaDueAt,
          createdAt: helpdeskTickets.createdAt,
          userId: helpdeskTickets.userId,
        })
        .from(helpdeskTickets)
        .where(
          and(
            eq(helpdeskTickets.orgId, orgId),
            inArray(helpdeskTickets.status, ["TODO", "IN_PROGRESS", "IN_REVIEW"]),
          ),
        )
        .orderBy(desc(helpdeskTickets.createdAt))
        .limit(50);

      for (const r of rows) {
        if (!isAdmin && r.assigneeId !== userId && r.userId !== userId) {
          continue;
        }
        const aging = classifyAging(r.createdAt, now, r.slaDueAt);
        items.push({
          kind: "helpdesk",
          id: r.id,
          ref: `HD-${r.id}`,
          title: r.title,
          status: r.status,
          severity: r.priority,
          assignedTo: r.assigneeId,
          href: `/hr/helpdesk?ticket=${r.id}`,
          createdAt: r.createdAt.toISOString(),
          aging,
          severityRank: severityRank("helpdesk", r.priority),
        });
      }
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

  /** Employee view: my open helpdesk tickets + cases I reported (non-confidential summary). */
  async getMyItems(orgId: string, userId: string): Promise<ServiceDeliveryMyItems> {
    const now = new Date();
    const items: ServiceDeliveryItem[] = [];

    const tickets = await this.db
      .select({
        id: helpdeskTickets.id,
        title: helpdeskTickets.title,
        status: helpdeskTickets.status,
        priority: helpdeskTickets.priority,
        assigneeId: helpdeskTickets.assigneeId,
        slaDueAt: helpdeskTickets.slaDueAt,
        createdAt: helpdeskTickets.createdAt,
      })
      .from(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgId),
          eq(helpdeskTickets.userId, userId),
          inArray(helpdeskTickets.status, ["TODO", "IN_PROGRESS", "IN_REVIEW"]),
        ),
      )
      .orderBy(desc(helpdeskTickets.createdAt))
      .limit(30);

    for (const r of tickets) {
      const aging = classifyAging(r.createdAt, now, r.slaDueAt);
      items.push({
        kind: "helpdesk",
        id: r.id,
        ref: `HD-${r.id}`,
        title: r.title,
        status: r.status,
        severity: r.priority,
        assignedTo: r.assigneeId,
        href: `/hr/helpdesk?ticket=${r.id}`,
        createdAt: r.createdAt.toISOString(),
        aging,
        severityRank: severityRank("helpdesk", r.priority),
      });
    }

    const cases = await this.db
      .select({
        id: hrCases.id,
        caseNumber: hrCases.caseNumber,
        summary: hrCases.summary,
        status: hrCases.status,
        severity: hrCases.severity,
        assignedTo: hrCases.assignedTo,
        createdAt: hrCases.createdAt,
        confidential: hrCases.confidential,
      })
      .from(hrCases)
      .where(
        and(
          eq(hrCases.orgId, orgId),
          isNull(hrCases.deletedAt),
          eq(hrCases.reportedBy, userId),
          inArray(hrCases.status, ["open", "under_investigation"]),
        ),
      )
      .orderBy(desc(hrCases.createdAt))
      .limit(30);

    for (const r of cases) {
      const aging = classifyAging(r.createdAt, now);
      items.push({
        kind: "case",
        id: r.id,
        ref: r.caseNumber,
        title: r.confidential ? "Confidential case (limited detail)" : r.summary,
        status: r.status,
        severity: r.severity,
        assignedTo: r.assignedTo,
        href: `/hr/cases?id=${r.id}`,
        createdAt: r.createdAt.toISOString(),
        aging,
        severityRank: severityRank("case", r.severity),
        confidential: r.confidential,
      });
    }

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
