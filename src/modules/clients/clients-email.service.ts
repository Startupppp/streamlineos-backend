import { Inject, Injectable } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";

function notificationEmailHtml(title: string, message: string, link?: string): string {
  const button = link
    ? `<div style="text-align:center;margin:24px 0;"><a href="${appUrl}${link}" style="background:#0f2b7f;color:#bd882c;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;">View Details</a></div>`
    : "";
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><div style="background:linear-gradient(135deg,#0f2b7f,#1e40af);padding:24px;text-align:center;border-radius:10px 10px 0 0;"><h1 style="color:#bd882c;margin:0;font-size:22px;">StreamlineOS</h1></div><div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;"><h2 style="color:#1e40af;margin-top:0;">${title}</h2><p>${message}</p>${button}</div></body></html>`;
}

@Injectable()
export class ClientsEmailService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  private sendNotificationEmail(to: string, title: string, message: string, link?: string): Promise<void> {
    return this.email.sendEmail({
      to,
      subject: `${title} — StreamlineOS`,
      html: notificationEmailHtml(title, message, link),
    });
  }

  async sendInvestmentEmails(
    accountId: number,
    salesRepId: string,
    clientName: string,
    formattedAmount: string,
    hrUserIds: string[],
  ): Promise<void> {
    const [salesRep, hrUsers] = await Promise.all([
      this.db.query.users.findFirst({ where: eq(users.id, salesRepId), columns: { email: true, name: true } }),
      hrUserIds.length > 0
        ? this.db.select({ email: users.email }).from(users).where(inArray(users.id, hrUserIds))
        : Promise.resolve([] as { email: string | null }[]),
    ]);

    const sends: Promise<void>[] = [];
    if (salesRep?.email) {
      sends.push(
        this.sendNotificationEmail(
          salesRep.email,
          "Client Invested!",
          `${clientName} has invested ₹${formattedAmount}. Your incentive is being processed.`,
          `/crm/clients/${accountId}`,
        ),
      );
    }
    for (const hr of hrUsers) {
      if (!hr.email) continue;
      sends.push(
        this.sendNotificationEmail(
          hr.email,
          "Client Invested!",
          `${clientName} has invested ₹${formattedAmount}. Sales rep: ${salesRep?.name ?? "N/A"}.`,
          `/crm/clients/${accountId}`,
        ),
      );
    }
    await Promise.allSettled(sends);
  }
}
