import { Inject, Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { eq, and, desc, count } from "drizzle-orm";
import { enterpriseQuotes } from "../../../db/schema/billing/billing";
import { users } from "../../../db/schema/common/auth";
import { clientAccounts } from "../../../db/schema/crm/contacts";
import { deals } from "../../../db/schema/crm/deals";
import type {
  CreateEnterpriseQuoteInput,
  ApproveEnterpriseQuoteInput,
  RejectEnterpriseQuoteInput,
  ListEnterpriseQuotesQuery,
} from "./dto/enterprise-quotes.schemas";

@Injectable()
export class EnterpriseQuotesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private generateRef(seq: number): string {
    return `EQ-${String(seq).padStart(4, "0")}`;
  }

  async list(orgId: string, query: ListEnterpriseQuotesQuery) {
    const offset = (query.page - 1) * query.limit;
    const where = query.status
      ? and(eq(enterpriseQuotes.orgId, orgId), eq(enterpriseQuotes.status, query.status))
      : eq(enterpriseQuotes.orgId, orgId);

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: enterpriseQuotes.id,
          quoteRef: enterpriseQuotes.quoteRef,
          subject: enterpriseQuotes.subject,
          planTier: enterpriseQuotes.planTier,
          negotiatedSeats: enterpriseQuotes.negotiatedSeats,
          pricePerSeatInPaise: enterpriseQuotes.pricePerSeatInPaise,
          contractTermMonths: enterpriseQuotes.contractTermMonths,
          status: enterpriseQuotes.status,
          validUntil: enterpriseQuotes.validUntil,
          createdAt: enterpriseQuotes.createdAt,
          dealName: deals.name,
          clientName: clientAccounts.clientName,
        })
        .from(enterpriseQuotes)
        .leftJoin(deals, eq(enterpriseQuotes.dealId, deals.id))
        .leftJoin(clientAccounts, eq(enterpriseQuotes.clientId, clientAccounts.id))
        .where(where)
        .orderBy(desc(enterpriseQuotes.createdAt))
        .limit(query.limit)
        .offset(offset),
      this.db.select({ total: count() }).from(enterpriseQuotes).where(where),
    ]);

    return {
      items,
      total: Number(total),
      page: query.page,
      totalPages: Math.ceil(Number(total) / query.limit),
    };
  }

  async findOne(orgId: string, id: number) {
    const [row] = await this.db
      .select({
        quote: enterpriseQuotes,
        dealId: deals.id,
        dealName: deals.name,
        clientId: clientAccounts.id,
        clientName: clientAccounts.clientName,
        approverName: users.name,
      })
      .from(enterpriseQuotes)
      .leftJoin(deals, eq(enterpriseQuotes.dealId, deals.id))
      .leftJoin(clientAccounts, eq(enterpriseQuotes.clientId, clientAccounts.id))
      .leftJoin(users, eq(enterpriseQuotes.approverId, users.id))
      .where(and(eq(enterpriseQuotes.orgId, orgId), eq(enterpriseQuotes.id, id)))
      .limit(1);

    if (!row) throw new NotFoundException("Enterprise quote not found");

    const q = row.quote;
    const totalValueInPaise = q.negotiatedSeats * q.pricePerSeatInPaise * q.contractTermMonths;

    return {
      ...q,
      totalValueInPaise,
      deal: row.dealId ? { id: row.dealId, name: row.dealName } : null,
      client: row.clientId ? { id: row.clientId, name: row.clientName } : null,
      approver: q.approverId ? { id: q.approverId, name: row.approverName ?? null } : null,
    };
  }

  async create(orgId: string, userId: string, dto: CreateEnterpriseQuoteInput) {
    const [{ seq }] = await this.db
      .select({ seq: count() })
      .from(enterpriseQuotes)
      .where(eq(enterpriseQuotes.orgId, orgId));
    const quoteRef = this.generateRef(Number(seq) + 1);

    const [created] = await this.db
      .insert(enterpriseQuotes)
      .values({
        orgId,
        quoteRef,
        subject: dto.subject,
        requestedSeats: dto.requestedSeats,
        negotiatedSeats: dto.negotiatedSeats,
        pricePerSeatInPaise: dto.pricePerSeatInPaise,
        contractTermMonths: dto.contractTermMonths,
        contractTerms: dto.contractTerms,
        validUntil: dto.validUntil,
        notes: dto.notes,
        dealId: dto.dealId,
        clientId: dto.clientId,
        createdById: userId,
      })
      .returning({ id: enterpriseQuotes.id, quoteRef: enterpriseQuotes.quoteRef });
    return created;
  }

  async submit(orgId: string, id: number) {
    const quote = await this.findOne(orgId, id);
    if (quote.status !== "DRAFT") throw new BadRequestException("Only DRAFT quotes can be submitted");
    await this.db
      .update(enterpriseQuotes)
      .set({ status: "PENDING_APPROVAL" })
      .where(and(eq(enterpriseQuotes.orgId, orgId), eq(enterpriseQuotes.id, id)));
    return { success: true };
  }

  async approve(orgId: string, id: number, approverId: string, dto: ApproveEnterpriseQuoteInput) {
    const quote = await this.findOne(orgId, id);
    if (quote.status !== "PENDING_APPROVAL") throw new BadRequestException("Only PENDING_APPROVAL quotes can be approved");
    await this.db
      .update(enterpriseQuotes)
      .set({ status: "APPROVED", approverId, approvalNotes: dto.notes, approvedAt: new Date() })
      .where(and(eq(enterpriseQuotes.orgId, orgId), eq(enterpriseQuotes.id, id)));
    return { success: true };
  }

  async reject(orgId: string, id: number, approverId: string, dto: RejectEnterpriseQuoteInput) {
    const quote = await this.findOne(orgId, id);
    if (quote.status !== "PENDING_APPROVAL") throw new BadRequestException("Only PENDING_APPROVAL quotes can be rejected");
    await this.db
      .update(enterpriseQuotes)
      .set({ status: "DRAFT", approverId, rejectionReason: dto.reason, rejectedAt: new Date() })
      .where(and(eq(enterpriseQuotes.orgId, orgId), eq(enterpriseQuotes.id, id)));
    return { success: true };
  }

  async send(orgId: string, id: number) {
    const quote = await this.findOne(orgId, id);
    if (quote.status !== "APPROVED") throw new BadRequestException("Only APPROVED quotes can be sent");
    await this.db
      .update(enterpriseQuotes)
      .set({ status: "SENT", sentAt: new Date() })
      .where(and(eq(enterpriseQuotes.orgId, orgId), eq(enterpriseQuotes.id, id)));
    return { success: true };
  }

  async accept(orgId: string, id: number) {
    const quote = await this.findOne(orgId, id);
    if (quote.status !== "SENT") throw new BadRequestException("Only SENT quotes can be accepted");
    await this.db
      .update(enterpriseQuotes)
      .set({ status: "ACCEPTED", acceptedAt: new Date() })
      .where(and(eq(enterpriseQuotes.orgId, orgId), eq(enterpriseQuotes.id, id)));
    return { success: true };
  }
}
