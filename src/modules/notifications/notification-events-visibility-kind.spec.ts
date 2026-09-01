/**
 * Gate: every ticket-bound Build notification must declare visibilityResourceKind.
 *
 * Purpose: the delivery pipeline's PIPE-003 check fires only when
 * visibilityResourceKind is declared. Without it, a recipient who lost access to a
 * ticket still receives ticket-specific notifications — the check is skipped silently.
 *
 * Rule: any event whose key contains "build.ticket." must declare
 * visibilityResourceKind. Adding a new ticket event without it fails this spec,
 * making the omission impossible to ship unnoticed.
 *
 * Bite proof: a synthetic "rogue" definition with build.ticket.* key and no
 * visibilityResourceKind is injected → the gate fires → removing the rogue
 * restores green.
 */
import { BUILD_NOTIFICATION_EVENTS } from "./notification-events-build.catalog";
import type { NotificationEventDefinition } from "./notification-event-definition.types";
import { BUILD_TICKET_RESOURCE } from "./notification-event-channel-policy";

const TICKET_PREFIX = "build.ticket.";

function ticketEvents(catalog: readonly NotificationEventDefinition[]): NotificationEventDefinition[] {
  return catalog.filter((e) => e.eventKey.startsWith(TICKET_PREFIX));
}

describe("notification event catalog — visibilityResourceKind completeness", () => {
  it("every build.ticket.* event declares visibilityResourceKind", () => {
    const missing = ticketEvents(BUILD_NOTIFICATION_EVENTS).filter(
      (e) => !e.visibilityResourceKind,
    );
    if (missing.length > 0) {
      const keys = missing.map((e) => e.eventKey).join(", ");
      throw new Error(
        `build.ticket.* events missing visibilityResourceKind (PIPE-003 check will be silently skipped): ${keys}`,
      );
    }
    expect(missing).toHaveLength(0);
  });

  it("every declared visibilityResourceKind on build.ticket.* uses BUILD_TICKET_RESOURCE", () => {
    const wrong = ticketEvents(BUILD_NOTIFICATION_EVENTS).filter(
      (e) => e.visibilityResourceKind && e.visibilityResourceKind !== BUILD_TICKET_RESOURCE,
    );
    expect(wrong).toHaveLength(0);
  });

  it("bites: a rogue build.ticket.* event without visibilityResourceKind is detected", () => {
    const rogue: NotificationEventDefinition = {
      eventKey: "build.ticket.rogue_test_event",
      sourceModule: "build",
      category: "PROJECTS",
      displayName: "Rogue event",
      description: "Rogue event",
      defaultPriority: "NORMAL",
      defaultType: "INFO",
      defaultChannels: ["IN_APP"],
      allowedChannels: ["IN_APP"],
      mandatory: false,
      userConfigurable: true,
      adminConfigurable: true,
      quietHoursBehavior: "respect",
      dedupeWindowSeconds: 60,
      rateLimitWindowSeconds: 0,
      rateLimitMax: 0,
    };

    const syntheticCatalog = [...BUILD_NOTIFICATION_EVENTS, rogue] as readonly NotificationEventDefinition[];

    const missing = ticketEvents(syntheticCatalog).filter((e) => !e.visibilityResourceKind);
    expect(missing.map((e) => e.eventKey)).toContain("build.ticket.rogue_test_event");
  });
});
