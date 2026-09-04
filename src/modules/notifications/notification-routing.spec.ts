import { computeRouting, type RouteContext } from "./notification-routing.service";
import type { NotificationChannel, NotificationEventDefinition, RoutingResult } from "./notification.types";

function makeDef(over: Partial<NotificationEventDefinition> = {}): NotificationEventDefinition {
  return {
    eventKey: "project.task.assigned",
    sourceModule: "build",
    category: "PROJECTS",
    displayName: "Task assigned",
    description: "A task was assigned to you",
    defaultPriority: "HIGH",
    defaultType: "INFO",
    defaultChannels: ["IN_APP", "EMAIL"],
    allowedChannels: ["IN_APP", "EMAIL", "PUSH"],
    mandatory: false,
    userConfigurable: true,
    adminConfigurable: true,
    quietHoursBehavior: "respect",
    dedupeWindowSeconds: 0,
    rateLimitWindowSeconds: 0,
    rateLimitMax: 0,
    ...over,
  };
}

function makePrefs(channelEnabled: Partial<Record<NotificationChannel, boolean>> = {}, quietHours = { start: null as string | null, end: null as string | null, timezone: "UTC", includeWeekends: true }) {
  return {
    channelEnabled: { IN_APP: true, EMAIL: true, PUSH: true, SMS: false, WHATSAPP: false, WEBHOOK: true, ...channelEnabled },
    quietHours,
    categories: {},
    modulePreferences: {},
    eventPreferences: {},
    allowCriticalOverride: true,
  };
}

function baseCtx(over: Partial<RouteContext> = {}): RouteContext {
  return {
    definition: makeDef(),
    priority: "HIGH",
    now: new Date("2024-01-02T12:00:00Z"),
    prefs: makePrefs(),
    orgPolicy: null,
    availableChannels: new Set<NotificationChannel>(["IN_APP", "EMAIL"]),
    suppressedChannels: new Map(),
    // COMP-003: consent gates SMS and WHATSAPP only; this baseline routes neither,
    // and the consent tests live in notification-consent-routing.spec.ts.
    consentedChannels: new Set<NotificationChannel>(),
    ...over,
  };
}

const actionFor = (r: RoutingResult, channel: NotificationChannel) => r.channels.find((c) => c.channel === channel)?.action;

describe("computeRouting", () => {
  it("sends default channels for a standard event", () => {
    const r = computeRouting(baseCtx());
    expect(r.createInApp).toBe(true);
    expect(actionFor(r, "IN_APP")).toBe("SEND");
    expect(actionFor(r, "EMAIL")).toBe("SEND");
  });

  it("suppresses a channel the user turned off", () => {
    const r = computeRouting(baseCtx({ prefs: makePrefs({ EMAIL: false }) }));
    expect(actionFor(r, "EMAIL")).toBe("SUPPRESS");
    expect(r.channels.find((c) => c.channel === "EMAIL")?.reason).toBe("CHANNEL_DISABLED");
    expect(actionFor(r, "IN_APP")).toBe("SEND");
  });

  it("cannot mute an external channel of a mandatory event", () => {
    const def = makeDef({ mandatory: true, quietHoursBehavior: "always_bypass" });
    const r = computeRouting(baseCtx({ definition: def, prefs: makePrefs({ EMAIL: false }) }));
    expect(actionFor(r, "EMAIL")).toBe("SEND");
    expect(r.createInApp).toBe(true);
  });

  it("suppresses a channel with no configured provider", () => {
    const def = makeDef({ defaultChannels: ["IN_APP", "EMAIL", "PUSH"] });
    const r = computeRouting(baseCtx({ definition: def }));
    expect(actionFor(r, "PUSH")).toBe("SUPPRESS");
    expect(r.channels.find((c) => c.channel === "PUSH")?.reason).toBe("NO_PROVIDER");
  });

  it("honours suppression rules for non-mandatory events", () => {
    const suppressed = new Map<NotificationChannel, "MUTE">([["EMAIL", "MUTE"]]);
    const r = computeRouting(baseCtx({ suppressedChannels: suppressed }));
    expect(actionFor(r, "EMAIL")).toBe("SUPPRESS");
    expect(r.channels.find((c) => c.channel === "EMAIL")?.reason).toBe("MUTE");
  });

  it("defers external channels during quiet hours but keeps in-app immediate", () => {
    const def = makeDef({ defaultPriority: "NORMAL", quietHoursBehavior: "respect" });
    const r = computeRouting(
      baseCtx({
        definition: def,
        priority: "NORMAL",
        now: new Date("2024-01-02T23:00:00Z"),
        prefs: makePrefs({}, { start: "22:00", end: "07:00", timezone: "UTC", includeWeekends: true }),
      }),
    );
    expect(actionFor(r, "IN_APP")).toBe("SEND");
    expect(actionFor(r, "EMAIL")).toBe("SEND");
    expect(r.deferredUntil).not.toBeNull();
  });

  it("does not defer critical events when the user allows override", () => {
    const r = computeRouting(
      baseCtx({
        priority: "CRITICAL",
        now: new Date("2024-01-02T23:00:00Z"),
        prefs: makePrefs({}, { start: "22:00", end: "07:00", timezone: "UTC", includeWeekends: true }),
      }),
    );
    expect(r.deferredUntil).toBeNull();
  });

  it("produces a human-readable reason", () => {
    const r = computeRouting(baseCtx());
    expect(r.reasonText).toContain("Task assigned");
  });
});
