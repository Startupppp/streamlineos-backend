import { z } from "zod";

export const INVOICE_REMINDER_EVENT = "accounting.invoice.reminder.due";

export const invoiceReminderPayloadSchema = z.object({
  orgId: z.string().min(1),
  reminderLogId: z.number().int().positive(),
  invoiceId: z.number().int().positive(),
  invoiceNumber: z.string().min(1),
  channel: z.enum(["EMAIL", "WHATSAPP"]),
  offsetDays: z.number().int(),
  targetUserIds: z.array(z.string().min(1)).min(1).max(100),
});

type InvoiceReminderPayload = z.infer<typeof invoiceReminderPayloadSchema>;
