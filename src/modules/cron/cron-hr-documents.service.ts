import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { addDays, format } from "date-fns";
import { documents, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { HrAutomationEngineService } from "../hr/automations/hr-automation-engine.service";
import { getDocumentExpiryReminderEmailTemplate } from "../email/templates/hr";
import { appUrl } from "../email/app-url";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { logger } from "../../common/logger/logger.service";
import { forEachOrg } from "../../common/tenant";

const DEFAULT_LOCALE = "en-IN";

@Injectable()
export class CronHrDocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async processDocumentExpiry(): Promise<{ fired: number }> {
    const now = new Date();
    const todayStr = format(now, "yyyy-MM-dd");
    const thirtyDaysStr = format(addDays(now, 30), "yyyy-MM-dd");

    let fired = 0;

    await forEachOrg(this.db, "document-expiry", async (tx, orgId) => {
      const expiring = await tx
        .select({
          id: documents.id,
          orgId: documents.orgId,
          userId: documents.userId,
          name: documents.name,
          type: documents.type,
          expiryDate: documents.expiryDate,
          userEmail: users.email,
          userName: users.name,
        })
        .from(documents)
        .innerJoin(users, eq(users.id, documents.userId))
        .where(
          and(
            eq(documents.orgId, orgId),
            eq(documents.isActive, true),
            eq(documents.expiryReminderSent, false),
            isNotNull(documents.expiryDate),
            gte(documents.expiryDate, todayStr),
            lte(documents.expiryDate, thirtyDaysStr),
          ),
        )
        .limit(500);

      const remindedDocIds: number[] = [];
      for (const doc of expiring) {
        if (!doc.userEmail || !doc.userId || !doc.expiryDate) continue;

        const daysRemaining = Math.ceil(
          (new Date(doc.expiryDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
        );

        const expiryLabel = new Date(`${doc.expiryDate}T12:00:00Z`).toLocaleDateString(DEFAULT_LOCALE, {
          day: "numeric",
          month: "long",
          year: "numeric",
        });

        await this.hrAutomation.emit(doc.orgId, "document.expiring", {
          documentId: doc.id,
          userId: doc.userId,
          employeeName: doc.userName ?? "",
          documentName: doc.name,
          documentType: doc.type ?? "Document",
          expiryDate: doc.expiryDate,
          daysUntilExpiry: daysRemaining,
        });

        const html = getDocumentExpiryReminderEmailTemplate(
          doc.userName ?? "Employee",
          doc.name,
          doc.type ?? "Document",
          expiryLabel,
          daysRemaining,
          `${appUrl()}/hr/documents`,
        );

        try {
          await this.dispatch.emit({
            eventKey: "hr.document.expiring",
            orgId,
            targetUserIds: [doc.userId],
            entityType: "document",
            entityId: String(doc.id),
            title: `Action needed: ${doc.name} expires soon`,
            message: `${doc.name} expires in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}.`,
            link: `${appUrl()}/hr/documents`,
            emailHtml: html,
          });
          remindedDocIds.push(doc.id);
          fired++;
        } catch (error) {
          logger.error("Document expiry reminder failed", { documentId: doc.id, error });
        }
      }

      if (remindedDocIds.length > 0)
        await tx
          .update(documents)
          .set({ expiryReminderSent: true })
          .where(and(eq(documents.orgId, orgId), inArray(documents.id, remindedDocIds)));
    });

    logger.info("Document expiry check complete", { fired });
    return { fired };
  }
}
