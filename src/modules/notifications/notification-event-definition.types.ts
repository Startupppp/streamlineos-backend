import { notificationSuppressionReasonEnum } from "../../db/schema/common/enums";
import type { NotificationCategoryValue } from "./notifications.types";

/**
 * The event-definition vocabulary, kept apart from `notification.types.ts` on purpose.
 *
 * `notification.types.ts` needs `NotificationEventKey` from the catalog (REG-005 made
 * eventKey a real union), and the catalog needs these shapes to declare its entries —
 * which is a cycle. Both now depend on this leaf instead. `notification.types.ts`
 * re-exports everything here, so no existing importer changes.
 */
export type NotificationChannel =
  | "IN_APP"
  | "EMAIL"
  | "PUSH"
  | "SMS"
  | "WHATSAPP"
  | "WEBHOOK";

export type NotificationPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

export type NotificationLevel = "INFO" | "SUCCESS" | "WARNING" | "ERROR";

export type QuietHoursBehavior = "respect" | "bypass_if_high" | "always_bypass";

export type SuppressionReason = (typeof notificationSuppressionReasonEnum.enumValues)[number];

export const ALL_CHANNELS: readonly NotificationChannel[] = [
  "IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "WEBHOOK",
];

export interface NotificationEventDefinition {
  eventKey: string;
  sourceModule: string;
  category: NotificationCategoryValue;
  displayName: string;
  description: string;
  defaultPriority: NotificationPriority;
  defaultType: NotificationLevel;
  defaultChannels: NotificationChannel[];
  allowedChannels: NotificationChannel[];
  mandatory: boolean;
  userConfigurable: boolean;
  adminConfigurable: boolean;
  quietHoursBehavior: QuietHoursBehavior;
  dedupeWindowSeconds: number;
  rateLimitWindowSeconds: number;
  rateLimitMax: number;
  templateKey?: string;
  audienceResolver?: string;
  /**
   * PIPE-003. Names the resource kind whose object-level visibility guards this
   * event, e.g. "build.ticket". NULL/undefined means the event is self-scoped and
   * ACTIVE org membership is the whole authorization. When set, a resolver must be
   * registered for the kind — a missing one denies.
   */
  visibilityResourceKind?: string;
  /**
   * PIPE-012. Seconds after which an undelivered notification is worthless and is
   * dropped rather than sent. Absent means it never expires — correct for anything
   * durable (a payslip, a role change) and wrong for anything time-boxed.
   */
  ttlSeconds?: number;
}
