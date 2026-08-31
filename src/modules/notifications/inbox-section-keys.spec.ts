import { ASSIGNED_EVENT_KEYS, MENTION_EVENT_KEYS } from "./inbox-section-keys";
import { NOTIFICATION_EVENT_CATALOG } from "./notification-events.catalog";

describe("inbox section event keys", () => {
  it("pins the exact mention keys so a catalog addition is a reviewed change", () => {
    expect([...MENTION_EVENT_KEYS].sort()).toEqual([
      "build.comment.mention",
      "chat.message.mention",
      "knowledge.article.mentioned",
      "support.ticket.mention",
    ]);
  });

  it("pins the exact assignment keys so a catalog addition is a reviewed change", () => {
    expect([...ASSIGNED_EVENT_KEYS].sort()).toEqual([
      "build.ticket.assigned",
      "crm.client.assigned",
      "crm.lead.assigned",
      "hr.asset.assigned",
      "hr.helpdesk.ticket_assigned",
      "hr.performance.review_assigned",
      "support.ticket.assigned",
      "tasks.task.assigned",
    ]);
  });

  it("derives every key from the catalog, so no section can reference a dead key", () => {
    const catalog = new Set(NOTIFICATION_EVENT_CATALOG.map((event) => event.eventKey));
    for (const key of [...MENTION_EVENT_KEYS, ...ASSIGNED_EVENT_KEYS])
      expect(catalog.has(key)).toBe(true);
  });

  it("keeps the two sections disjoint", () => {
    const mentions = new Set(MENTION_EVENT_KEYS);
    for (const key of ASSIGNED_EVENT_KEYS) expect(mentions.has(key)).toBe(false);
  });
});
