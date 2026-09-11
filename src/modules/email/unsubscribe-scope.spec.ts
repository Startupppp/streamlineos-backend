import type { NotificationEventKey } from "../notifications/notification-events.catalog";
import { computeRouting } from "../notifications/notification-routing-computation";
import type {
  NotificationChannel,
  NotificationEventDefinition,
  SuppressionReason,
} from "../notifications/notification.types";
import { UNSUBSCRIBE_SCOPE_RULES } from "./unsubscribe-suppression";

const EVENT_KEY: NotificationEventKey = "chat.message.mention";

function definition(overrides: Partial<NotificationEventDefinition>): NotificationEventDefinition {
  return {
    eventKey: EVENT_KEY,
    displayName: "You were mentioned",
    category: "CHAT",
    sourceModule: "chat",
    defaultChannels: ["EMAIL"],
    allowedChannels: ["EMAIL", "IN_APP"],
    mandatory: false,
    ...overrides,
  } as NotificationEventDefinition;
}

function routeWithEmailRule(mandatory: boolean) {
  const suppressed = new Map<NotificationChannel, SuppressionReason>([
    ["EMAIL", "UNSUBSCRIBE" as SuppressionReason],
  ]);
  return computeRouting({
    definition: definition({ mandatory }),
    priority: "NORMAL",
    now: new Date("2026-01-05T12:00:00Z"),
    prefs: {
      channelEnabled: { IN_APP: true, EMAIL: true, PUSH: true, SMS: true, WHATSAPP: true, WEBHOOK: true },
      quietHours: { start: null, end: null, timezone: "UTC", includeWeekends: false },
      categories: {},
      modulePreferences: {},
      eventPreferences: {},
      allowCriticalOverride: true,
    },
    orgPolicy: null,
    availableChannels: new Set<NotificationChannel>(["IN_APP", "EMAIL"]),
    suppressedChannels: suppressed,
    consentedChannels: new Set<NotificationChannel>(),
  });
}

describe("one-click unsubscribe — hermetic", () => {
  it("every token scope maps to a rule the routing query actually matches", () => {
    expect(UNSUBSCRIBE_SCOPE_RULES.TYPE).toEqual({ scopeType: "event", useTokenKey: true });
    expect(UNSUBSCRIBE_SCOPE_RULES.CATEGORY).toEqual({ scopeType: "category", useTokenKey: true });
    expect(UNSUBSCRIBE_SCOPE_RULES.ALL_NON_MANDATORY).toEqual({ scopeType: "all", useTokenKey: false });
  });

  it("an EMAIL suppression rule stops a non-mandatory send and does not stop a mandatory one", () => {
    const optional = routeWithEmailRule(false);
    const mandatory = routeWithEmailRule(true);

    const emailOf = (result: ReturnType<typeof routeWithEmailRule>) =>
      result.channels.find((decision) => decision.channel === "EMAIL");

    expect(emailOf(optional)?.action).toBe("SUPPRESS");
    expect(emailOf(optional)?.reason).toBe("UNSUBSCRIBE");
    expect(emailOf(mandatory)?.action).toBe("SEND");
  });
});
