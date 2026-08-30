import { notificationCategoryEnum, notificationChannelEnum } from "../../db/schema/common/enums";
import { NOTIFICATION_EVENT_CATALOG, NOTIFICATION_EVENT_MAP } from "./notification-events.catalog";
import { IMPLEMENTED_VISIBILITY_RESOURCE_KINDS } from "./notification-visibility.registry";

/**
 * REG-001 regression guard. 19 accounting events declared category "ACCOUNTING"
 * while the pgEnum had 18 values without it, so every dispatch died 22P02 at the
 * notifications insert and the after-commit handler swallowed it. An `as
 * NotificationCategoryValue` cast hid it from tsc for the life of the product.
 *
 * The cast is gone and the union is now derived from the pgEnum, so a repeat is
 * a compile error. These assertions cover what the type system still cannot:
 * values that only Postgres validates, and cross-field agreement.
 */
/**
 * Events whose in-app surface is served by a dedicated endpoint rather than by
 * per-user notification rows. IN_APP is deliberately absent from allowedChannels
 * so the dispatch pipeline never fans out one row per recipient — for a
 * 50,000-member organisation that fan-out is the cost c21-02 removed. The event
 * is still reachable in-app: GET /broadcasts/inbox serves it from the broadcast
 * row via the absence-of-receipt pattern. Adding one here needs that endpoint.
 */
const FAN_OUT_ON_READ_EVENTS = new Set<string>(["notification.broadcast.published"]);

describe("notification event catalog integrity", () => {
  it("declares events used by migrated cron and payroll callers", () => {
    expect(NOTIFICATION_EVENT_MAP.has("billing.trial.expiring")).toBe(true);
    expect(NOTIFICATION_EVENT_MAP.has("system.weekly_recap")).toBe(true);
    expect(NOTIFICATION_EVENT_MAP.has("payroll.payslip.ready")).toBe(true);
  });

  it("declares every category as a member of the notification_category pgEnum", () => {
    const valid = new Set<string>(notificationCategoryEnum.enumValues);
    const offenders = NOTIFICATION_EVENT_CATALOG.filter((d) => !valid.has(d.category)).map(
      (d) => `${d.eventKey} → ${d.category}`,
    );
    expect(offenders).toEqual([]);
  });

  it("declares every channel as a member of the notification_channel pgEnum", () => {
    const valid = new Set<string>(notificationChannelEnum.enumValues);
    const offenders: string[] = [];
    for (const d of NOTIFICATION_EVENT_CATALOG) {
      for (const c of [...d.defaultChannels, ...d.allowedChannels])
        if (!valid.has(c)) offenders.push(`${d.eventKey} → ${c}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps defaultChannels a subset of allowedChannels", () => {
    const offenders: string[] = [];
    for (const d of NOTIFICATION_EVENT_CATALOG) {
      const allowed = new Set(d.allowedChannels);
      for (const c of d.defaultChannels)
        if (!allowed.has(c)) offenders.push(`${d.eventKey} → ${c} is default but not allowed`);
    }
    expect(offenders).toEqual([]);
  });

  it("has no duplicate event keys", () => {
    expect(NOTIFICATION_EVENT_MAP.size).toBe(NOTIFICATION_EVENT_CATALOG.length);
  });

  it("uses dot-separated lowercase event keys", () => {
    const offenders = NOTIFICATION_EVENT_CATALOG.filter(
      (d) => !/^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(d.eventKey),
    ).map((d) => d.eventKey);
    expect(offenders).toEqual([]);
  });

  it("never marks a mandatory event as muteable by the user", () => {
    const offenders = NOTIFICATION_EVENT_CATALOG.filter(
      (d) => d.mandatory && d.userConfigurable,
    ).map((d) => d.eventKey);
    expect(offenders).toEqual([]);
  });

  it("only declares visibility resource kinds that have a registered resolver", () => {
    const implemented = new Set<string>(IMPLEMENTED_VISIBILITY_RESOURCE_KINDS);
    const offenders = NOTIFICATION_EVENT_CATALOG.filter(
      (d) => d.visibilityResourceKind && !implemented.has(d.visibilityResourceKind),
    ).map((d) => `${d.eventKey} → ${d.visibilityResourceKind}`);
    expect(offenders).toEqual([]);
  });

  it("always includes IN_APP in allowedChannels so a notification is never unreachable", () => {
    const offenders = NOTIFICATION_EVENT_CATALOG.filter(
      (d) => !d.allowedChannels.includes("IN_APP") && !FAN_OUT_ON_READ_EVENTS.has(d.eventKey),
    ).map((d) => d.eventKey);
    expect(offenders).toEqual([]);
  });

  it("serves every fan-out-on-read event through a dedicated in-app surface", () => {
    for (const eventKey of FAN_OUT_ON_READ_EVENTS) {
      const declaration = NOTIFICATION_EVENT_CATALOG.find((d) => d.eventKey === eventKey);
      expect(declaration).toBeDefined();
      expect(declaration?.allowedChannels).not.toContain("IN_APP");
    }
  });
});
