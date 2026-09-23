import { computeRouting, type RouteContext } from "./notification-routing.service";
import type {
  NotificationChannel,
  NotificationEventDefinition,
  RoutingResult,
} from "./notification.types";

function makeDef(
  over: Partial<NotificationEventDefinition> = {},
): NotificationEventDefinition {
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

function makePrefs(
  over: {
    channelEnabled?: Partial<Record<NotificationChannel, boolean>>;
    categories?: Record<string, boolean>;
    modulePreferences?: Record<string, { muted?: boolean }>;
    eventPreferences?: Record<
      string,
      { muted?: boolean; channels?: Record<string, boolean> }
    >;
  } = {},
) {
  return {
    channelEnabled: {
      IN_APP: true,
      EMAIL: true,
      PUSH: true,
      SMS: false,
      WHATSAPP: false,
      WEBHOOK: true,
      ...over.channelEnabled,
    },
    quietHours: {
      start: null as string | null,
      end: null as string | null,
      timezone: "UTC",
      includeWeekends: true,
    },
    categories: over.categories ?? {},
    modulePreferences: over.modulePreferences ?? {},
    eventPreferences: over.eventPreferences ?? {},
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
    consentedChannels: new Set<NotificationChannel>(),
    ...over,
  };
}

const actionFor = (r: RoutingResult, channel: NotificationChannel) =>
  r.channels.find((c) => c.channel === channel)?.action;

const LOCKED = { defaultChannels: [], canUserOverride: false };
const OPEN = { defaultChannels: [], canUserOverride: true };

describe("an organisation policy that forbids overrides is not bypassable by a personal preference", () => {
  it("delivers on a channel the reader switched off globally", () => {
    const result = computeRouting(
      baseCtx({
        prefs: makePrefs({ channelEnabled: { EMAIL: false } }),
        orgPolicy: LOCKED,
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SEND");
  });

  it("CONTROL: the same switch still suppresses when the policy permits overrides", () => {
    const result = computeRouting(
      baseCtx({
        prefs: makePrefs({ channelEnabled: { EMAIL: false } }),
        orgPolicy: OPEN,
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SUPPRESS");
  });

  it("delivers when the reader muted the event", () => {
    const result = computeRouting(
      baseCtx({
        prefs: makePrefs({
          eventPreferences: { "project.task.assigned": { muted: true } },
        }),
        orgPolicy: LOCKED,
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SEND");
  });

  it("CONTROL: the same event mute still suppresses when the policy permits overrides", () => {
    const result = computeRouting(
      baseCtx({
        prefs: makePrefs({
          eventPreferences: { "project.task.assigned": { muted: true } },
        }),
        orgPolicy: OPEN,
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SUPPRESS");
  });

  it("delivers when the reader muted the whole module", () => {
    const result = computeRouting(
      baseCtx({
        prefs: makePrefs({ modulePreferences: { build: { muted: true } } }),
        orgPolicy: LOCKED,
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SEND");
  });

  it("delivers when the reader switched the category off", () => {
    const result = computeRouting(
      baseCtx({
        prefs: makePrefs({ categories: { PROJECTS: false } }),
        orgPolicy: LOCKED,
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SEND");
  });

  it("delivers despite a personal suppression rule", () => {
    const result = computeRouting(
      baseCtx({
        suppressedChannels: new Map<NotificationChannel, "MUTE">([
          ["EMAIL", "MUTE"],
        ]),
        orgPolicy: LOCKED,
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SEND");
  });

  it("CONTROL: the same suppression rule still applies when the policy permits overrides", () => {
    const result = computeRouting(
      baseCtx({
        suppressedChannels: new Map<NotificationChannel, "MUTE">([
          ["EMAIL", "MUTE"],
        ]),
        orgPolicy: OPEN,
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SUPPRESS");
  });
});

describe("forbidding overrides does not override the organisation's own policy, or the law", () => {
  it("still honours the organisation's own mute on the event", () => {
    const result = computeRouting(
      baseCtx({
        orgPolicy: {
          defaultChannels: [],
          canUserOverride: false,
          eventOverride: { muted: true },
        },
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SUPPRESS");
  });

  it("still refuses a channel with no configured provider", () => {
    const result = computeRouting(
      baseCtx({
        prefs: makePrefs({ channelEnabled: { EMAIL: false } }),
        orgPolicy: LOCKED,
        availableChannels: new Set<NotificationChannel>(["IN_APP"]),
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SUPPRESS");
  });

  it("still refuses a consent-bound channel with no recorded consent", () => {
    const result = computeRouting(
      baseCtx({
        definition: makeDef({
          defaultChannels: ["IN_APP", "SMS"],
          allowedChannels: ["IN_APP", "SMS"],
        }),
        prefs: makePrefs({ channelEnabled: { SMS: false } }),
        orgPolicy: LOCKED,
        availableChannels: new Set<NotificationChannel>(["IN_APP", "SMS"]),
        consentedChannels: new Set<NotificationChannel>(),
      }),
    );

    expect(actionFor(result, "SMS")).toBe("SUPPRESS");
  });

  it("CONTROL: the same consent-bound channel sends once consent is recorded", () => {
    const result = computeRouting(
      baseCtx({
        definition: makeDef({
          defaultChannels: ["IN_APP", "SMS"],
          allowedChannels: ["IN_APP", "SMS"],
        }),
        prefs: makePrefs({ channelEnabled: { SMS: false } }),
        orgPolicy: LOCKED,
        availableChannels: new Set<NotificationChannel>(["IN_APP", "SMS"]),
        consentedChannels: new Set<NotificationChannel>(["SMS"]),
      }),
    );

    expect(actionFor(result, "SMS")).toBe("SEND");
  });

  it("leaves an absent policy permissive, so the default stays the reader's own choice", () => {
    const result = computeRouting(
      baseCtx({
        prefs: makePrefs({ channelEnabled: { EMAIL: false } }),
        orgPolicy: null,
      }),
    );

    expect(actionFor(result, "EMAIL")).toBe("SUPPRESS");
  });
});
