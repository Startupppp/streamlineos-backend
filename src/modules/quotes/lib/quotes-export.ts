import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { quotes, users, deals, clientAccounts } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { ExportInput } from "../dto/quote.schemas";

export async function buildQuotesExportCsv(
  db: Db,
  orgId: string,
  userId: string,
  filters: ExportInput,
  audit: AuditService,
): Promise<string> {
  const baseConditions = [eq(quotes.orgId, orgId), isNull(quotes.deletedAt)];
  if (filters.status) baseConditions.push(eq(quotes.status, filters.status));

  const EXPORT_PAGE = 500;
  const data: Array<{
    quoteNumber: string;
    subject: string;
    status: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED";
    currency: string;
    totalAmount: string | null;
    taxAmount: string | null;
    netAmount: string | null;
    validUntil: string | null;
    createdBy: string | null;
    dealName: string | null;
    clientName: string | null;
    createdAt: Date | null;
    sentAt: Date | null;
    acceptedAt: Date | null;
  }> = [];
  let afterId = 0;
  for (;;) {
    const page = await db
      .select({
        id: quotes.id,
        quoteNumber: quotes.quoteNumber,
        subject: quotes.subject,
        status: quotes.status,
        currency: quotes.currency,
        totalAmount: quotes.totalAmount,
        taxAmount: quotes.taxAmount,
        netAmount: quotes.netAmount,
        validUntil: quotes.validUntil,
        createdBy: users.name,
        dealName: deals.name,
        clientName: clientAccounts.clientName,
        createdAt: quotes.createdAt,
        sentAt: quotes.sentAt,
        acceptedAt: quotes.acceptedAt,
      })
      .from(quotes)
      .leftJoin(users, eq(quotes.createdById, users.id))
      .leftJoin(deals, eq(quotes.dealId, deals.id))
      .leftJoin(clientAccounts, eq(quotes.clientId, clientAccounts.id))
      .where(and(...baseConditions, gt(quotes.id, afterId)))
      .orderBy(asc(quotes.id))
      .limit(EXPORT_PAGE);
    for (const row of page) data.push(row);
    const last = page[page.length - 1];
    if (page.length < EXPORT_PAGE || last === undefined) break;
    afterId = last.id;
  }

  const headers = [
    "Quote #", "Subject", "Status", "Currency", "Total", "Tax", "Net",
    "Valid Until", "Deal", "Client", "Created By", "Created At", "Sent At", "Accepted At",
  ];
  const rows = data.map((q) => [
    q.quoteNumber, q.subject, q.status, q.currency,
    q.totalAmount, q.taxAmount, q.netAmount, q.validUntil,
    q.dealName || "", q.clientName || "", q.createdBy || "",
    q.createdAt ? new Date(q.createdAt).toISOString() : "",
    q.sentAt ? new Date(q.sentAt).toISOString() : "",
    q.acceptedAt ? new Date(q.acceptedAt).toISOString() : "",
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map((val) => `"${String(val ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  audit.log({
    action: "quote.exported",
    userId,
    orgId,
    metadata: { format: "csv", recordCount: rows.length },
  });

  return csv;
}
