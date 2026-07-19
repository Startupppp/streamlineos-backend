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

export type SuppressionReason =
  | "DEDUPE"
  | "MUTE"
  | "UNSUBSCRIBE"
  | "INVALID_RECIPIENT"
  | "RATE_LIMIT"
  | "QUIET_HOURS"
  | "NO_PROVIDER"
  | "CONSENT_MISSING"
  | "CHANNEL_DISABLED"
  | "COST_LIMIT";

export const ALL_CHANNELS: readonly NotificationChannel[] = [
  "IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "WEBHOOK",
];

export interface NotificationEventDefinition {
  eventKey: string;
  sourceModule: string;
  category: string;
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
}

export interface DispatchEventInput {
  eventKey: string;
  orgId: string;
  actorUserId?: string | null;
  targetUserIds: string[];
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

