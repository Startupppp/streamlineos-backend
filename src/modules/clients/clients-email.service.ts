import { Inject, Injectable } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";
import { getClientInvestmentEmailTemplate } from "../email/templates/crm";

@Injectable()
export class ClientsEmailService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async sendInvestmentEmails(
    accountId: number,
    salesRepId: string,
    clientName: string,
    formattedAmount: string,
    hrUserIds: string[],
  ): Promise<void> {
    const [salesRep, hrUsers] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, salesRepId),
        columns: { email: true, name: true },
      }),
      hrUserIds.length > 0
        ? this.db
            .select({ email: users.email, name: users.name })
            .from(users)
            .where(inArray(users.id, hrUserIds))
        : Promise.resolve([] as { email: string | null; name: string | null }[]),
    ]);

    const amount = `₹${formattedAmount}`;
    const date = new Date().toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const recordedBy = salesRep?.name ?? "N/A";
    const clientUrl = `${appUrl}/crm/clients/${accountId}`;

    const sends: Promise<void>[] = [];

    if (salesRep?.email) {
      const { subject, html } = getClientInvestmentEmailTemplate({
        recipientName: salesRep.name ?? "Team Member",
        clientName,
        amount,
        date,
        recordedBy,
        clientUrl,
      });
      sends.push(this.email.sendEmail({ to: salesRep.email, subject, html }));
    }

    for (const hr of hrUsers) {
      if (!hr.email) continue;
      const { subject, html } = getClientInvestmentEmailTemplate({
        recipientName: hr.name ?? "Team Member",
        clientName,
        amount,
        date,
        recordedBy,
        clientUrl,
      });
      sends.push(this.email.sendEmail({ to: hr.email, subject, html }));
    }

    await Promise.allSettled(sends);
  }
}
