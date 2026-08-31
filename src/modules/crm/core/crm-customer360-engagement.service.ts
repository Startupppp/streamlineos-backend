import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { deals, projects, quotes, supportTickets, csatSurveys } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { SECTION_LIMIT, type Customer360Section } from "./crm-customer360.types";

@Injectable()
export class CrmCustomer360EngagementService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async fetchSupportTicketsForOrg(orgId: string): Promise<Customer360Section<unknown>> {
    const where = eq(supportTickets.orgId, orgId);
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: supportTickets.id, title: supportTickets.title, status: supportTickets.status, priority: supportTickets.priority, createdAt: supportTickets.createdAt })
        .from(supportTickets)
        .where(where)
        .orderBy(desc(supportTickets.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(supportTickets)
        .where(where)
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchSupportTicketsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: supportTickets.id, title: supportTickets.title, status: supportTickets.status, priority: supportTickets.priority, createdAt: supportTickets.createdAt })
        .from(supportTickets)
        .where(and(eq(supportTickets.orgId, orgId), eq(supportTickets.clientId, clientId)))
        .orderBy(desc(supportTickets.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(supportTickets)
        .where(and(eq(supportTickets.orgId, orgId), eq(supportTickets.clientId, clientId)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchSurveysForOrg(orgId: string): Promise<Customer360Section<unknown>> {
    const where = eq(csatSurveys.orgId, orgId);
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: csatSurveys.id, title: csatSurveys.title, status: csatSurveys.status, createdAt: csatSurveys.createdAt })
        .from(csatSurveys)
        .where(where)
        .orderBy(desc(csatSurveys.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(csatSurveys)
        .where(where)
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchSurveysForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: csatSurveys.id, title: csatSurveys.title, status: csatSurveys.status, createdAt: csatSurveys.createdAt })
        .from(csatSurveys)
        .where(and(eq(csatSurveys.orgId, orgId), eq(csatSurveys.clientId, clientId)))
        .orderBy(desc(csatSurveys.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(csatSurveys)
        .where(and(eq(csatSurveys.orgId, orgId), eq(csatSurveys.clientId, clientId)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchProjectsForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: projects.id, name: projects.name, status: projects.status, startDate: projects.startDate, endDate: projects.endDate, createdAt: projects.createdAt })
        .from(projects)
        .innerJoin(deals, and(eq(deals.id, projects.dealId), sql`${deals.name} ILIKE ${"%" + safe + "%"}`))
        .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
        .orderBy(desc(projects.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(projects)
        .innerJoin(deals, and(eq(deals.id, projects.dealId), sql`${deals.name} ILIKE ${"%" + safe + "%"}`))
        .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchProjectsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: projects.id, name: projects.name, status: projects.status, startDate: projects.startDate, endDate: projects.endDate, createdAt: projects.createdAt })
        .from(projects)
        .innerJoin(deals, and(eq(deals.id, projects.dealId), eq(deals.clientId, clientId)))
        .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
        .orderBy(desc(projects.createdAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(projects)
        .innerJoin(deals, and(eq(deals.id, projects.dealId), eq(deals.clientId, clientId)))
        .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchSignedDocumentsForOrg(orgId: string, orgName: string): Promise<Customer360Section<unknown>> {
    const safe = orgName.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, signedAt: quotes.signedAt, signedDocumentRef: quotes.signedDocumentRef, createdAt: quotes.createdAt })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), isNotNull(quotes.signedAt), sql`${quotes.subject} ILIKE ${"%" + safe + "%"}`))
        .orderBy(desc(quotes.signedAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), isNotNull(quotes.signedAt), sql`${quotes.subject} ILIKE ${"%" + safe + "%"}`))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }

  async fetchSignedDocumentsForClient(orgId: string, clientId: number): Promise<Customer360Section<unknown>> {
    const [items, countRow] = await Promise.all([
      this.db
        .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, subject: quotes.subject, status: quotes.status, signedAt: quotes.signedAt, signedDocumentRef: quotes.signedDocumentRef, createdAt: quotes.createdAt })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), eq(quotes.clientId, clientId), isNotNull(quotes.signedAt)))
        .orderBy(desc(quotes.signedAt))
        .limit(SECTION_LIMIT),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(quotes)
        .where(and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), eq(quotes.clientId, clientId), isNotNull(quotes.signedAt)))
        .then((rows) => rows[0]),
    ]);
    return { items, total: Number(countRow?.count ?? 0) };
  }
}
