import type { NotificationEventKey } from "./notification-events.catalog";
export * from "./notification-event-definition.types";
import type {
  NotificationChannel,
  NotificationPriority,
  NotificationLevel,
  SuppressionReason,
} from "./notification-event-definition.types";

export interface DispatchEventInput {
  /** REG-005: only keys declared in the catalog compile. */
  eventKey: NotificationEventKey;
  orgId: string;
  actorUserId?: string | null;
  targetUserIds: string[];
  /**
   * PIPE-011. The actor is excluded from `targetUserIds` by default — nobody wants
   * to be told about their own action. Set true only where self-notification is the
   * point, e.g. a security alert about your own session.
   */
  notifySelf?: boolean;
  entityType?: string;
  entityId?: string;
  title?: string;
  message?: string;
  link?: string;
  priority?: NotificationPriority;
  category?: string;
  variables?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ChannelDecision {
  channel: NotificationChannel;
  action: "SEND" | "SUPPRESS";
  reason?: SuppressionReason;
  detail?: string;
}

export interface RoutingResult {
  userId: string;
  createInApp: boolean;
  channels: ChannelDecision[];
  priority: NotificationPriority;
  deferredUntil: Date | null;
  reasonText: string;
}

export interface ProviderSendInput {
  orgId: string;
  userId: string;
  /** COMP-002: mandatory mail must not advertise an unsubscribe it will not honour. */
  mandatory?: boolean;
  channel: NotificationChannel;
  recipientAddress?: string | null;
  title: string;
  message: string;
  link?: string | null;
  priority: NotificationPriority;
  metadata?: Record<string, unknown>;
  sandbox: boolean;
}

export interface ProviderSendResult {
  status: "SENT" | "FAILED";
  providerMessageId?: string;
  providerResponse?: Record<string, unknown>;
  costAmount?: number;
  costCurrency?: string;
  failureCode?: string;
  failureMessage?: string;
  retryable?: boolean;
}

export interface ProviderValidationResult {
  valid: boolean;
  message?: string;
}

