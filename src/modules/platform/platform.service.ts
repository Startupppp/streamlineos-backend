import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { eq, sql, gte, desc, ilike, or, and, isNull, count, type SQL } from "drizzle-orm";
import {
  platformVisits,
  platformMessages,
  platformPayments,
  platformSubscriptions,
  organizations,
  organizationMembers,
  users,
  leads,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { getSupportEmail } from "../email/email.constants";
import {
  getContactAdminNotificationEmail,
  getContactAutoreplyEmail,
  getContactReplyEmail,
} from "../email/templates/platform";
import type { VisitInput, ListMessagesQuery, ContactFormInput } from "./dto/platform.schemas";

export interface VisitMeta {
  userAgent: string | null;
  country: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const inr = (paise: number) => Math.round(paise / 100);

const BRAND_URL = (process.env.APP_URL ?? "").replace(/\/$/, "");

const TOPIC_LABEL: Record<string, string> = {
  sales: "Talk to sales",
  support: "Get support",
  partnership: "Partnership",
  press: "Press",
  other: "Something else",
};

function getContactRecipients(): string[] {
  const recipient = process.env.CONTACT_NOTIFICATION_EMAIL?.trim();
  return recipient ? [recipient] : [getSupportEmail()];
}

@Injectable()
export class PlatformService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async submitContactForm(input: ContactFormInput): Promise<{ ok: true }> {
    const reference = `MSG-${randomBytes(6).toString("hex").toUpperCase()}`;

    await this.db.insert(platformMessages).values({
      publicCode: reference,
      name: input.name,
      email: input.email,
      company: input.company ?? null,
      phone: input.phone ?? null,
      topic: input.topic ?? "other",
      message: input.message,
      status: "NEW",
    });

    const adminRecipients = getContactRecipients();
    const topicLabel = TOPIC_LABEL[input.topic ?? "other"] ?? "Something else";
    const receivedAt = new Date().toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });

    try {
      const adminEmail = getContactAdminNotificationEmail({
        name: input.name,
        email: input.email,
        topic: topicLabel,
        message: input.message,
        reference,
        receivedAt,
        company: input.company,
        phone: input.phone,
        inboxUrl: `${BRAND_URL}/owner/inbox/${reference}`,
      });
      await this.email.sendEmail({
        to: adminRecipients,
        subject: adminEmail.subject,
        html: adminEmail.html,
        replyTo: input.email,
      });
    } catch (error) {
      logger.warn("[contact-form] Admin notification failed", { error });
    }

    try {
      const autoreplyEmail = getContactAutoreplyEmail({ name: input.name, message: input.message });
      await this.email.sendEmail({
        to: input.email,
        subject: autoreplyEmail.subject,
        html: autoreplyEmail.html,
        replyTo: getSupportEmail(),
      });
    } catch (error) {
      logger.warn("[contact-form] Customer auto-reply failed", { error });
    }

    return { ok: true };
  }

  async recordVisit(input: VisitInput, meta: VisitMeta) {
    try {
      const existing = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(platformVisits)
        .where(eq(platformVisits.sessionToken, input.sessionToken))
        .then((r) => r[0]?.n ?? 0);

      await this.db.insert(platformVisits).values({
        sessionToken: input.sessionToken,
        path: input.path,
        referrer: input.referrer ?? null,
        userAgent: meta.userAgent,
        country: meta.country,
        isFirstVisit: existing === 0,
      });
    } catch (error) {
      logger.warn("[visit] beacon failed", { error });
    }
  }

  async getDashboardMetrics() {
    const now = new Date();
    const since30d = new Date(now.getTime() - 30 * DAY_MS);
    const since7d = new Date(now.getTime() - 7 * DAY_MS);

    const [
      totalCustomers,
      activeCustomers,
      totalUsers,
      totalMessages,
      unreadMessages,
      totalLeads,
      newLeads7d,
      visits30d,
      uniqueVisits30d,
      revenue30d,
      revenueLifetime,
      txCount,
      visitsByDayRows,
      revenueByMonthRows,
    ] = await Promise.all([
      this.db.select({ n: sql<number>`count(*)::int` }).from(organizations).then((r) => r[0]?.n ?? 0),
      this.db
        .select({ n: sql<number>`count(distinct ${organizationMembers.orgId})::int` })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(gte(users.updatedAt, since30d))
        .then((r) => r[0]?.n ?? 0)
        .catch(() => 0),
      this.db.select({ n: sql<number>`count(*)::int` }).from(users).then((r) => r[0]?.n ?? 0),
      this.db.select({ n: sql<number>`count(*)::int` }).from(platformMessages).then((r) => r[0]?.n ?? 0),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(platformMessages)
        .where(eq(platformMessages.status, "NEW"))
        .then((r) => r[0]?.n ?? 0),
      this.db.select({ n: sql<number>`count(*)::int` }).from(leads).then((r) => r[0]?.n ?? 0),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(leads)
        .where(gte(leads.createdAt, since7d))
        .then((r) => r[0]?.n ?? 0),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .then((r) => r[0]?.n ?? 0),
      this.db
        .select({ n: sql<number>`count(distinct ${platformVisits.sessionToken})::int` })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .then((r) => r[0]?.n ?? 0),
      this.db
        .select({ sum: sql<number>`coalesce(sum(${platformPayments.amount}), 0)::int` })
        .from(platformPayments)
        .where(and(eq(platformPayments.status, "captured"), gte(platformPayments.createdAt, since30d)))
        .then((r) => r[0]?.sum ?? 0),
      this.db
        .select({ sum: sql<number>`coalesce(sum(${platformPayments.amount}), 0)::int` })
        .from(platformPayments)
        .where(eq(platformPayments.status, "captured"))
        .then((r) => r[0]?.sum ?? 0),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(platformPayments)
        .where(eq(platformPayments.status, "captured"))
        .then((r) => r[0]?.n ?? 0),
      this.db
        .select({
          date: sql<string>`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .groupBy(sql`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`),
      this.db
        .select({
          month: sql<string>`to_char(${platformPayments.createdAt}, 'YYYY-MM')`,
          amount: sql<number>`coalesce(sum(${platformPayments.amount}), 0)::int`,
        })
        .from(platformPayments)
        .where(eq(platformPayments.status, "captured"))
        .groupBy(sql`to_char(${platformPayments.createdAt}, 'YYYY-MM')`)
        .orderBy(sql`to_char(${platformPayments.createdAt}, 'YYYY-MM')`),
    ]);

    return {
      customers: { total: totalCustomers, activeLast30d: activeCustomers },
      users: { total: totalUsers },
      messages: { total: totalMessages, unread: unreadMessages },
      leads: { total: totalLeads, newLast7d: newLeads7d },
      visits: { last30d: visits30d, uniqueLast30d: uniqueVisits30d },
      revenue: {
        last30dInr: inr(revenue30d),
        lifetimeInr: inr(revenueLifetime),
        transactions: txCount,
      },
      series: {
        visitsByDay: visitsByDayRows,
        revenueByMonth: revenueByMonthRows.map((r) => ({ month: r.month, amount: inr(r.amount) })),
      },
    };
  }

  async listCustomers() {
    return this.db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        createdAt: organizations.createdAt,
        userCount: sql<number>`coalesce((
          select count(*)::int from ${organizationMembers}
          where ${organizationMembers.orgId} = ${organizations.id}
        ), 0)`,
        plan: platformSubscriptions.plan,
        status: sql<string>`coalesce(${platformSubscriptions.status}, 'free')`,
        lifetimeInr: sql<number>`coalesce((
          select sum(${platformPayments.amount})::int / 100
          from ${platformPayments}
          where ${platformPayments.orgId} = ${organizations.id}
            and ${platformPayments.status} = 'captured'
        ), 0)`,
      })
      .from(organizations)
      .leftJoin(platformSubscriptions, eq(platformSubscriptions.orgId, organizations.id))
      .orderBy(desc(organizations.createdAt));
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
      this.db.query.platformSubscriptions.findFirst({
        where: eq(platformSubscriptions.orgId, org.id),
      }),
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
        id: leads.id,
        name: leads.name,
        email: leads.email,
        company: leads.company,
        status: leads.status,
        source: leads.source,
        orgName: organizations.name,
        orgSlug: organizations.slug,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .leftJoin(organizations, eq(organizations.id, leads.orgId))
      .orderBy(desc(leads.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      publicCode: `LEAD-${r.id.toString().padStart(5, "0")}`,
      name: r.name,
      email: r.email,
      company: r.company,
      status: r.status ?? "NEW",
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

  async getRevenueSummary() {
    const [byStatus, byMonth, byMethod] = await Promise.all([
      this.db
        .select({
          status: platformPayments.status,
          count: sql<number>`count(*)::int`,
          total: sql<number>`coalesce(sum(${platformPayments.amount})::int / 100, 0)`,
        })
        .from(platformPayments)
        .groupBy(platformPayments.status),
      this.db
        .select({
          month: sql<string>`to_char(${platformPayments.createdAt}, 'YYYY-MM')`,
          amount: sql<number>`coalesce(sum(${platformPayments.amount})::int / 100, 0)`,
        })
        .from(platformPayments)
        .where(eq(platformPayments.status, "captured"))
        .groupBy(sql`to_char(${platformPayments.createdAt}, 'YYYY-MM')`)
        .orderBy(sql`to_char(${platformPayments.createdAt}, 'YYYY-MM')`),
      this.db
        .select({
          method: sql<string>`coalesce(${platformPayments.method}, 'unknown')`,
          count: sql<number>`count(*)::int`,
        })
        .from(platformPayments)
        .where(eq(platformPayments.status, "captured"))
        .groupBy(platformPayments.method),
    ]);
    return { byStatus, byMonth, byMethod };
  }

  async getVisitorAnalytics() {
    const since30d = new Date(Date.now() - 30 * DAY_MS);

    const [byDay, topPaths, topReferrers, recent] = await Promise.all([
      this.db
        .select({
          date: sql<string>`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`,
          visits: sql<number>`count(*)::int`,
          unique: sql<number>`count(distinct ${platformVisits.sessionToken})::int`,
        })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .groupBy(sql`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`),
      this.db
        .select({ path: platformVisits.path, visits: sql<number>`count(*)::int` })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .groupBy(platformVisits.path)
        .orderBy(desc(sql`count(*)`))
        .limit(10),
      this.db
        .select({ referrer: platformVisits.referrer, visits: sql<number>`count(*)::int` })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .groupBy(platformVisits.referrer)
        .orderBy(desc(sql`count(*)`))
        .limit(10),
      this.db
        .select({
          path: platformVisits.path,
          referrer: platformVisits.referrer,
          country: platformVisits.country,
          userAgent: platformVisits.userAgent,
          createdAt: platformVisits.createdAt,
        })
        .from(platformVisits)
        .orderBy(desc(platformVisits.createdAt))
        .limit(50),
    ]);

    return { byDay, topPaths, topReferrers, recent };
  }

  async listPlatformAdmins(): Promise<{ id: string; email: string; name: string | null }[]> {
    return this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.isPlatformAdmin, true))
      .orderBy(users.email);
  }

  async grantPlatformAdmin(email: string): Promise<{ id: string; email: string; name: string | null }> {
    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${email.toLowerCase().trim()}`,
      columns: { id: true, email: true, name: true, isPlatformAdmin: true },
    });
    if (!user) throw new NotFoundException("No user found with that email");
    if (user.isPlatformAdmin) throw new ConflictException("User is already a platform admin");

    await this.db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));

    return { id: user.id, email: user.email, name: user.name ?? null };
  }

  async revokePlatformAdmin(userId: string): Promise<{ ok: true }> {
    const [countRow] = await this.db
      .select({ n: count() })
      .from(users)
      .where(eq(users.isPlatformAdmin, true));
    const total = Number(countRow?.n ?? 0);
    if (total <= 1) throw new ConflictException("Cannot remove the last platform admin");

    await this.db.update(users).set({ isPlatformAdmin: false }).where(eq(users.id, userId));

    return { ok: true };
  }

  async getLayoutData(userId: string) {
    const [unreadRow, ownerRow] = await Promise.all([
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(platformMessages)
        .where(and(eq(platformMessages.status, "NEW"), isNull(platformMessages.repliedAt)))
        .then((r) => r[0]?.n ?? 0),
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { name: true, email: true, firstName: true, lastName: true },
      }),
    ]);

    const ownerName =
      ownerRow?.name ||
      [ownerRow?.firstName, ownerRow?.lastName].filter(Boolean).join(" ") ||
      (ownerRow?.email ?? "Platform Owner");

    return {
      unreadCount: unreadRow,
      ownerName,
      ownerEmail: ownerRow?.email ?? "",
    };
  }
}