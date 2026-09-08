import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { hrCases } from "../../../db/schema/hr/cases";
import { hrSafetyIncidents } from "../../../db/schema/hr/safety";
import { helpdeskTickets } from "../../../db/schema";
import {
  classifyAging,
  severityRank,
  type AgingResult,
} from "./lib/service-delivery-aging";
import type { ServiceDeliveryItem } from "./lib/service-delivery-item";

export async function fetchCasesForOpsInbox(
  db: Db,
  orgId: string,
  membershipId: number | null | undefined,
  hasConfidential: boolean,
  now: Date,
): Promise<ServiceDeliveryItem[]> {
  const caseConditions = [
    eq(hrCases.orgId, orgId),
    isNull(hrCases.deletedAt),
    inArray(hrCases.status, ["open", "under_investigation"]),
  ];
  if (!hasConfidential) {
    const assigneeMatch = membershipId != null
      ? eq(hrCases.assignedToMembershipId, membershipId)
      : sql`false`;
    const vis = or(eq(hrCases.confidential, false), assigneeMatch);
    if (vis) caseConditions.push(vis);
  }
  const rows = await db
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

  return rows.map((r) => {
    const aging: AgingResult = classifyAging(r.createdAt, now);
    return {
      kind: "case" as const,
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
    };
  });
}

export async function fetchSafetyForOpsInbox(
  db: Db,
  orgId: string,
  now: Date,
): Promise<ServiceDeliveryItem[]> {
  const rows = await db
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

  return rows.map((r) => {
    const aging: AgingResult = classifyAging(r.createdAt, now);
    return {
      kind: "safety_incident" as const,
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
    };
  });
}

export async function fetchHelpdeskForOpsInbox(
  db: Db,
  orgId: string,
  userId: string,
  isAdmin: boolean,
  now: Date,
): Promise<ServiceDeliveryItem[]> {
  const rows = await db
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

  const items: ServiceDeliveryItem[] = [];
  for (const r of rows) {
    if (!isAdmin && r.assigneeId !== userId && r.userId !== userId) continue;
    const aging: AgingResult = classifyAging(r.createdAt, now, r.slaDueAt);
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
  return items;
}

export async function fetchHelpdeskForMyItems(
  db: Db,
  orgId: string,
  userId: string,
  now: Date,
): Promise<ServiceDeliveryItem[]> {
  const rows = await db
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

  return rows.map((r) => {
    const aging: AgingResult = classifyAging(r.createdAt, now, r.slaDueAt);
    return {
      kind: "helpdesk" as const,
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
    };
  });
}

export async function fetchCasesForMyItems(
  db: Db,
  orgId: string,
  membershipId: number | null | undefined,
  now: Date,
): Promise<ServiceDeliveryItem[]> {
  const rows = await db
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
        membershipId != null
          ? eq(hrCases.reportedByMembershipId, membershipId)
          : sql`false`,
        inArray(hrCases.status, ["open", "under_investigation"]),
      ),
    )
    .orderBy(desc(hrCases.createdAt))
    .limit(30);

  return rows.map((r) => {
    const aging: AgingResult = classifyAging(r.createdAt, now);
    return {
      kind: "case" as const,
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
    };
  });
}
