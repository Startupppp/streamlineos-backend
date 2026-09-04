import type { Db } from "../../db/drizzle.module";
import { NotificationRoutingService } from "./notification-routing.service";
import { computeRouting, CONSENT_REQUIRED_CHANNELS } from "./notification-routing-computation";
import type {
  NotificationChannel,
  NotificationEventDefinition,
  RoutingResult,
  SuppressionReason,
} from "./notification.types";

/**
 * COMP-003. `notification_consents`, `notification_consent_events` and the
 * `CONSENT_MISSING` suppression reason were declared, migrated, and read by nothing
 * except the GDPR export adapter — which therefore exported an empty list for every
 * subject. SMS and WhatsApp routed on preferences, org policy and suppression rules
 * alone, so two channels that legally cannot ship without a recorded agreement
 * shipped on a toggle.
 *
 * These pin both halves: the decision in `computeRouting`, and the fact that
 * `routeMany` actually loads the table rather than passing an empty set.
 */
const GRANTED_USER = "user-consented";
const UNGRANTED_USER = "user-unconsented";

function makeDef(over: Partial<NotificationEventDefinition> = {}): NotificationEventDefinition {
  return {
    eventKey: "hr.shift.reminder",
    sourceModule: "hr",
    category: "HRMS",
    displayName: "Shift reminder",
    description: "Your shift starts soon",
    defaultPriority: "NORMAL",
    defaultType: "INFO",
    defaultChannels: ["IN_APP", "EMAIL", "SMS"],
    allowedChannels: ["IN_APP", "EMAIL", "SMS", "WHATSAPP"],
    mandatory: false,
    userConfigurable: true,
    adminConfigurable: true,
    quietHoursBehavior: "always_bypass",
    dedupeWindowSeconds: 0,
    rateLimitWindowSeconds: 0,
    rateLimitMax: 0,
    ...over,
  };
}

function prefs(channelEnabled: Partial<Record<NotificationChannel, boolean>> = {}) {
  return {
    channelEnabled: {
      IN_APP: true,
      EMAIL: true,
      PUSH: true,
      SMS: true,
      WHATSAPP: true,
      WEBHOOK: true,
      ...channelEnabled,
    },
    quietHours: { start: null, end: null, timezone: "UTC", includeWeekends: true },
    categories: {},
    modulePreferences: {},
    eventPreferences: {},
    allowCriticalOverride: true,
  };
}

const actionFor = (r: RoutingResult, channel: NotificationChannel) =>
  r.channels.find((c) => c.channel === channel)?.action;
const reasonFor = (r: RoutingResult, channel: NotificationChannel) =>
  r.channels.find((c) => c.channel === channel)?.reason;

function route(
  consented: NotificationChannel[],
  over: Partial<NotificationEventDefinition> = {},
): RoutingResult {
  return computeRouting({
    definition: makeDef(over),
    priority: "NORMAL",
    now: new Date("2026-02-01T12:00:00Z"),
    prefs: prefs(),
    orgPolicy: null,
    availableChannels: new Set<NotificationChannel>(["IN_APP", "EMAIL", "SMS", "WHATSAPP"]),
    suppressedChannels: new Map<NotificationChannel, SuppressionReason>(),
    consentedChannels: new Set<NotificationChannel>(consented),
  });
}

describe("consent enforcement in computeRouting", () => {
  it("gates exactly SMS and WhatsApp", () => {
    expect([...CONSENT_REQUIRED_CHANNELS].sort()).toEqual(["SMS", "WHATSAPP"]);
  });

  it("suppresses SMS with CONSENT_MISSING when no consent is recorded", () => {
    const r = route([]);
    expect(actionFor(r, "SMS")).toBe("SUPPRESS");
    expect(reasonFor(r, "SMS")).toBe("CONSENT_MISSING");
  });

  it("sends SMS once consent is recorded, everything else being equal", () => {
    const r = route(["SMS"]);
    expect(actionFor(r, "SMS")).toBe("SEND");
  });

  it("keeps consent per channel — an SMS grant is not a WhatsApp grant", () => {
    const r = route(["SMS"], { defaultChannels: ["IN_APP", "SMS", "WHATSAPP"] });
    expect(actionFor(r, "SMS")).toBe("SEND");
    expect(actionFor(r, "WHATSAPP")).toBe("SUPPRESS");
    expect(reasonFor(r, "WHATSAPP")).toBe("CONSENT_MISSING");
  });

  it("leaves EMAIL, PUSH and IN_APP ungated — unsubscribe governs those", () => {
    const r = route([], {
      defaultChannels: ["IN_APP", "EMAIL", "PUSH"],
      allowedChannels: ["IN_APP", "EMAIL", "PUSH"],
    });
    expect(actionFor(r, "EMAIL")).toBe("SEND");
    expect(actionFor(r, "IN_APP")).toBe("SEND");
  });

  it("binds a mandatory event too, and falls back instead of texting anyway", () => {
    const r = route([], { mandatory: true, defaultChannels: ["IN_APP", "SMS"] });
    expect(actionFor(r, "SMS")).toBe("SUPPRESS");
    expect(reasonFor(r, "SMS")).toBe("CONSENT_MISSING");
    // FALLBACK_CHAIN carries SMS -> EMAIL, so the obligation to reach the person
    // is met without inventing a legal basis to text them.
    expect(actionFor(r, "EMAIL")).toBe("SEND");
  });

  it("never falls back onto a consent-gated channel either", () => {
    const r = route([], {
      mandatory: true,
      defaultChannels: ["IN_APP", "WHATSAPP"],
      allowedChannels: ["IN_APP", "WHATSAPP", "SMS"],
    });
    expect(actionFor(r, "WHATSAPP")).toBe("SUPPRESS");
    expect(actionFor(r, "SMS")).not.toBe("SEND");
  });
});

/**
 * The half a pure-function test cannot reach: whether the service ever asks the
 * database. The defect was not a wrong decision, it was a decision made with an
 * input nobody loaded.
 */
function makeDb(consentRows: Array<{ userId: string; channel: NotificationChannel }>): Db {
  const terminal = (rows: unknown[]) => ({
    limit: jest.fn().mockResolvedValue(rows),
    groupBy: jest.fn().mockResolvedValue([]),
  });

  const select = jest.fn().mockImplementation((projection: Record<string, unknown>) => {
    const keys = Object.keys(projection ?? {});
    const isConsent = keys.length === 2 && keys.includes("userId") && keys.includes("channel");
    const isPrefs = keys.includes("inAppEnabled");
    const isAvailability = keys.length === 1 && keys.includes("channel");

    let rows: unknown[] = [];
    if (isConsent) rows = consentRows;
    else if (isAvailability) rows = [{ channel: "SMS" }, { channel: "WHATSAPP" }];
    else if (isPrefs)
      rows = [GRANTED_USER, UNGRANTED_USER].map((userId) => ({
        userId,
        inAppEnabled: true,
        emailEnabled: true,
        pushEnabled: true,
        smsEnabled: true,
        whatsappEnabled: true,
        quietHoursStart: null,
        quietHoursEnd: null,
        quietHoursWeekends: true,
        allowCriticalOverride: true,
      }));

    const chain: Record<string, unknown> = { ...terminal(rows) };
    chain["from"] = jest.fn().mockReturnValue(chain);
    chain["innerJoin"] = jest.fn().mockReturnValue(chain);
    chain["where"] = jest.fn().mockReturnValue(chain);
    return chain;
  });

  return {
    select,
    query: {
      notificationPolicyDefaults: { findFirst: jest.fn().mockResolvedValue(undefined) },
      notificationSuppressionRules: { findMany: jest.fn().mockResolvedValue([]) },
    },
  } as unknown as Db;
}

describe("NotificationRoutingService loads consent", () => {
  const cache = {
    cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()),
  } as never;

  it("routes SMS for the consented recipient and suppresses it for the other", async () => {
    const db = makeDb([{ userId: GRANTED_USER, channel: "SMS" }]);
    const svc = new NotificationRoutingService(db, cache);

    const results = await svc.routeMany(
      "org-1",
      [GRANTED_USER, UNGRANTED_USER],
      makeDef(),
      "NORMAL",
    );

    const granted = results.get(GRANTED_USER);
    const ungranted = results.get(UNGRANTED_USER);
    if (granted === undefined || ungranted === undefined)
      throw new Error("routeMany returned no result for a requested recipient");

    expect(actionFor(granted, "SMS")).toBe("SEND");
    expect(actionFor(ungranted, "SMS")).toBe("SUPPRESS");
    expect(reasonFor(ungranted, "SMS")).toBe("CONSENT_MISSING");
  });

  it("suppresses for everyone when the table holds nothing", async () => {
    const db = makeDb([]);
    const svc = new NotificationRoutingService(db, cache);

    const results = await svc.routeMany("org-1", [GRANTED_USER], makeDef(), "NORMAL");
    const only = results.get(GRANTED_USER);
    if (only === undefined) throw new Error("routeMany returned no result");
    expect(reasonFor(only, "SMS")).toBe("CONSENT_MISSING");
  });
});
