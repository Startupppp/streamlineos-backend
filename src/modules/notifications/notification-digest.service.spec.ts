import { NotificationDigestService } from "./notification-digest.service";

/**
 * PIPE-008 / PIPE-004.
 *
 * The two failure modes worth pinning down are both silent ones: a digest that never
 * arrives because its window keeps being pushed forward, and a preference value the
 * service does not recognise being read as "hold this indefinitely".
 */
describe("NotificationDigestService", () => {
  describe("windowMsFor", () => {
    it("maps the supported digest modes", () => {
      expect(NotificationDigestService.windowMsFor("hourly")).toBe(3_600_000);
      expect(NotificationDigestService.windowMsFor("daily")).toBe(86_400_000);
      expect(NotificationDigestService.windowMsFor("weekly")).toBe(604_800_000);
    });

    // null means "send immediately". An unrecognised mode has to fall back to sending
    // rather than holding: delivering something early is recoverable, holding it
    // forever is not, and a stored preference could be anything.
    it("sends immediately for no mode and for an unrecognised mode", () => {
      expect(NotificationDigestService.windowMsFor(null)).toBeNull();
      expect(NotificationDigestService.windowMsFor(undefined)).toBeNull();
      expect(NotificationDigestService.windowMsFor("")).toBeNull();
      expect(NotificationDigestService.windowMsFor("instant")).toBeNull();
      expect(NotificationDigestService.windowMsFor("DAILY")).toBeNull();
    });
  });

  describe("enqueue", () => {
    interface Captured {
      values?: Record<string, unknown>;
      conflict?: { set: Record<string, unknown> };
    }

    function harness() {
      const captured: Captured = {};
      const db = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn((v: Record<string, unknown>) => {
            captured.values = v;
            return {
              onConflictDoUpdate: jest.fn((c: { set: Record<string, unknown> }) => {
                captured.conflict = c;
                return Promise.resolve();
              }),
            };
          }),
        }),
      };
      const notifications = { create: jest.fn() };
      const svc = new NotificationDigestService(
        db as unknown as ConstructorParameters<typeof NotificationDigestService>[0],
        notifications as unknown as ConstructorParameters<typeof NotificationDigestService>[1],
      );
      return { svc, captured };
    }

    const base = {
      orgId: "org-a",
      membershipId: 41,
      channel: "EMAIL" as const,
      eventKey: "build.comment.mention",
      entityType: "ticket",
      entityId: "42",
      title: "New comment",
      message: "body",
      windowMs: 3_600_000,
    };

    it("coalesces on event and entity, so repeats land on one row", async () => {
      const { svc, captured } = harness();
      await svc.enqueue(base);
      expect(captured.values?.coalesceKey).toBe("build.comment.mention:ticket:42");
    });

    it("counts a repeat instead of overwriting it", async () => {
      const { svc, captured } = harness();
      await svc.enqueue(base);
      expect(captured.conflict?.set.occurrenceCount).toBeDefined();
      expect(captured.conflict?.set.lastSeenAt).toBeInstanceOf(Date);
    });

    // The bug this guards: extending the deadline on every occurrence means a busy
    // thread perpetually resets its own window and the digest is never sent at all.
    it("does not push the delivery deadline forward on a repeat", async () => {
      const { svc, captured } = harness();
      await svc.enqueue(base);
      expect(captured.values?.deliverAfter).toBeInstanceOf(Date);
      expect(captured.conflict?.set).not.toHaveProperty("deliverAfter");
    });
  });
});
