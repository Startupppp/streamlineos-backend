import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "crypto";
import { eq, sql, and, isNull } from "drizzle-orm";
import {
  platformMessages,
  platformVisits,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { getSupportEmail } from "../email/branding";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import {
  getContactAdminNotificationEmail,
  getContactAutoreplyEmail,
} from "../email/templates/platform";
import type { VisitInput, ContactFormInput } from "./dto/platform.schemas";

export interface VisitMeta {
  userAgent: string | null;
  country: string | null;
}

@Injectable()
export class PlatformService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly email: EmailService,
  ) {}

  private get brandUrl(): string {
    return this.config.APP_URL.replace(/\/$/, "");
  }

  private getContactRecipients(): string[] {
    const recipient = this.config.CONTACT_NOTIFICATION_EMAIL?.trim();
    return recipient ? [recipient] : [getSupportEmail()];
  }

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

    const adminRecipients = this.getContactRecipients();
    const TOPIC_LABEL: Record<string, string> = {
      sales: "Talk to sales",
      support: "Get support",
      partnership: "Partnership",
      press: "Press",
      other: "Something else",
    };
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
        inboxUrl: `${this.brandUrl}/owner/inbox/${reference}`,
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
