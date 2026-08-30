import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, sql, desc, ilike, or, and, isNull, lt, inArray, type SQL } from "drizzle-orm";
import {
  platformMessages,
  platformPayments,
  organizations,
  organizationMembers,
  subscriptions,
  users,
} from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { PARTY_OF_LEAD, leadSource, leadStatus } from "../crm/crm-party-reads";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { getSupportEmail } from "../email/branding";
import { getContactReplyEmail } from "../email/templates/platform";
import type { ListMessagesQuery } from "./dto/platform.schemas";

@Injectable()
export class PlatformAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async listCustomers(cursor?: { afterCreatedAt: Date; afterId: string }) {
    const PAGE_SIZE = 100;

    const cursorCond = cursor
      ? or(
          lt(organizations.createdAt, cursor.afterCreatedAt),
          and(
            eq(organizations.createdAt, cursor.afterCreatedAt),
            lt(organizations.id, cursor.afterId),
          ),
        )
      : undefined;

    const orgRows = await this.db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .where(cursorCond)
      .orderBy(desc(organizations.createdAt), desc(organizations.id))
      .limit(PAGE_SIZE + 1);

    const hasNextPage = orgRows.length > PAGE_SIZE;
    const page = orgRows.slice(0, PAGE_SIZE);

    if (page.length === 0) return { items: [], nextCursor: null };

    const orgIds = page.map((r) => r.id);

    const [memberCounts, paymentTotals, subRows] = await Promise.all([
      this.db
        .select({
          orgId: organizationMembers.orgId,
          count: sql<number>`count(*)::int`,
        })
        .from(organizationMembers)
        .where(inArray(organizationMembers.orgId, orgIds))
        .groupBy(organizationMembers.orgId),
      this.db
        .select({
          orgId: platformPayments.orgId,
          total: sql<number>`coalesce(sum(${platformPayments.amount})::int / 100, 0)`,
        })
        .from(platformPayments)
        .where(
          and(
            inArray(platformPayments.orgId, orgIds),
            eq(platformPayments.status, "captured"),
          ),
        )
        .groupBy(platformPayments.orgId),
      this.db
        .select({
          orgId: subscriptions.orgId,
          plan: subscriptions.plan,
          status: subscriptions.status,
          subId: subscriptions.id,
        })
        .from(subscriptions)
        .where(inArray(subscriptions.orgId, orgIds))
        .orderBy(desc(subscriptions.id)),
    ]);

    const memberMap = new Map(memberCounts.map((r) => [r.orgId, r.count]));
    const paymentMap = new Map(paymentTotals.map((r) => [r.orgId, r.total]));

    const subscriptionMap = new Map<string, { plan: string; status: string }>();
    for (const row of subRows) {
      if (!subscriptionMap.has(row.orgId)) {
        subscriptionMap.set(row.orgId, { plan: row.plan, status: row.status });
      }
    }

    const lastItem = page[page.length - 1];
    const nextCursor =
      hasNextPage && lastItem
        ? { afterCreatedAt: lastItem.createdAt, afterId: lastItem.id }
        : null;

    return {
      items: page.map((org) => {
        const sub = subscriptionMap.get(org.id);
        return {
          id: org.id,
          slug: org.slug,
          name: org.name,
          createdAt: org.createdAt,
          userCount: memberMap.get(org.id) ?? 0,
          plan: sub?.plan ?? null,
          status: sub?.status ?? "free",
          lifetimeInr: paymentMap.get(org.id) ?? 0,
        };
      }),
      nextCursor,
    };
  }

  async getCustomerBySlug(slug: string) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, slug),
    });
    if (!org) throw new NotFoundException("Customer not found");

    const [members, payments, subscription] = await Promise.all([
      this.db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: organizationMembers.role,
          joinedAt: organizationMembers.joinedAt,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(organizationMembers.orgId, org.id))
        .orderBy(desc(organizationMembers.joinedAt))
        .limit(50),
      this.db.query.platformPayments.findMany({
        where: eq(platformPayments.orgId, org.id),
        orderBy: desc(platformPayments.createdAt),
        limit: 50,
      }),
      this.db
        .select({
          id: subscriptions.id,
          plan: subscriptions.plan,
          status: subscriptions.status,
          razorpaySubscriptionId: subscriptions.razorpaySubscriptionId,
          currentPeriodStart: subscriptions.currentPeriodStart,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          trialEndsAt: subscriptions.trialEndsAt,
          cancelledAt: subscriptions.cancelledAt,
          createdAt: subscriptions.createdAt,
          updatedAt: subscriptions.updatedAt,
        })
        .from(subscriptions)
        .where(eq(subscriptions.orgId, org.id))
        .orderBy(desc(subscriptions.id))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    return { org, members, payments, subscription: subscription ?? null };
  }

  async listMessages(filter: ListMessagesQuery) {
    const conditions: SQL[] = [];
    if (filter.status && filter.status !== "ALL") {
      conditions.push(eq(platformMessages.status, filter.status));
    }
    if (filter.topic && filter.topic !== "ALL") {
      conditions.push(eq(platformMessages.topic, filter.topic));
    }
    if (filter.search) {
      const q = `%${filter.search}%`;
      const searchCondition = or(
        ilike(platformMessages.name, q),
        ilike(platformMessages.email, q),
        ilike(platformMessages.company, q),
        ilike(platformMessages.message, q),
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    return this.db.query.platformMessages.findMany({
      where: conditions.length === 0 ? undefined : and(...conditions),
      orderBy: desc(platformMessages.createdAt),
      limit: 200,
    });
  }

  async getMessageByPublicCode(code: string) {
    const message = await this.db.query.platformMessages.findFirst({
      where: eq(platformMessages.publicCode, code),
    });
    if (!message) throw new NotFoundException("Message not found");
    return message;
  }

  async updateMessageStatus(code: string, status: string) {
    await this.db
      .update(platformMessages)
      .set({ status })
      .where(eq(platformMessages.publicCode, code));
    return { ok: true };
  }

  async markMessageReplied(code: string, repliedById: string, replyBody: string) {
    await this.db
      .update(platformMessages)
      .set({ status: "REPLIED", repliedAt: new Date(), repliedById, replyBody })
      .where(eq(platformMessages.publicCode, code));
    return { ok: true };
  }

  async replyToMessage(code: string, body: string, repliedById: string): Promise<{ ok: true }> {
    const message = await this.getMessageByPublicCode(code);
    const replyEmail = getContactReplyEmail({
      name: message.name,
      replyBody: body,
      originalMessage: message.message,
      originalTopic: message.topic,
    });
    await this.email.sendEmail({
      to: message.email,
      subject: replyEmail.subject,
      html: replyEmail.html,
      replyTo: getSupportEmail(),
    });
    await this.db
      .update(platformMessages)
      .set({ status: "REPLIED", repliedAt: new Date(), repliedById, replyBody: body })
      .where(eq(platformMessages.publicCode, code));
    return { ok: true };
  }

  async listLeads(limit = 200) {
    const rows = await this.db
      .select({
        id: leadPartyMap.leadId,
        name: businessParties.name,
        email: businessParties.email,
        company: businessParties.companyName,
        status: leadStatus,
        source: leadSource,
        orgName: organizations.name,
        orgSlug: organizations.slug,
        createdAt: businessParties.createdAt,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .leftJoin(organizations, eq(organizations.id, leadPartyMap.organizationId))
      .where(isNull(businessParties.deletedAt))
      .orderBy(desc(businessParties.createdAt), desc(leadPartyMap.leadId))
      .limit(Math.min(limit, 400));

    return rows.map((r) => ({
      publicCode: `LEAD-${r.id.toString().padStart(5, "0")}`,
      name: r.name,
      email: r.email,
      company: r.company,
      status: r.status,
      source: r.source,
      organizationName: r.orgName,
      organizationSlug: r.orgSlug,
      createdAt: r.createdAt,
    }));
  }

  async listPayments(limit = 100) {
    return this.db
      .select({
        id: platformPayments.id,
        razorpayPaymentId: platformPayments.razorpayPaymentId,
        amount: platformPayments.amount,
        currency: platformPayments.currency,
        status: platformPayments.status,
        method: platformPayments.method,
        description: platformPayments.description,
        customerEmail: platformPayments.customerEmail,
        orgName: organizations.name,
        orgSlug: organizations.slug,
        createdAt: platformPayments.createdAt,
      })
      .from(platformPayments)
      .leftJoin(organizations, eq(organizations.id, platformPayments.orgId))
      .orderBy(desc(platformPayments.createdAt))
      .limit(limit);
  }
}
