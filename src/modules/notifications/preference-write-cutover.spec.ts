import { NotificationPreferencesService } from "./notification-preferences.service";

/**
 * SCH-003 write cutover.
 *
 * Routing resolves mutes and category switches from `notification_preference_rules`
 * ONLY — the JSONB columns are no longer read. The read side was cut over first, which
 * left a gap: the preference centre still wrote JSONB, still reported the toggle as
 * saved, and changed nothing about what was actually sent. A user muting a notification
 * would have kept receiving it, silently and indefinitely.
 *
 * These tests assert on the rule rows the update projects, because that is the only
 * thing routing will look at.
 */
describe("NotificationPreferencesService — preference rule projection", () => {
  interface Captured {
    deleted: Array<Record<string, unknown>>;
    inserted: Array<Record<string, unknown>>;
  }

  function harness() {
    const captured: Captured = { deleted: [], inserted: [] };
    const db = {
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((v: unknown) => {
          const rows = Array.isArray(v) ? v : [v];
          // The header upsert returns rows; the rules upsert does not.
          if (rows[0] && "scopeType" in (rows[0] as object)) {
            captured.inserted.push(...(rows as Array<Record<string, unknown>>));
            return { onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) };
          }
          return {
            onConflictDoUpdate: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 1 }]),
            }),
          };
        }),
      })),
      delete: jest.fn(() => ({
        where: jest.fn((clause: unknown) => {
          captured.deleted.push({ clause });
          return Promise.resolve();
        }),
      })),
    };
    const svc = new NotificationPreferencesService(
      db as unknown as ConstructorParameters<typeof NotificationPreferencesService>[0],
      { assertKnown: jest.fn(), listForOrg: jest.fn() } as unknown as ConstructorParameters<
        typeof NotificationPreferencesService
      >[1],
      {
        withdrawChannels: jest.fn().mockResolvedValue(0),
        withdrawChannel: jest.fn().mockResolvedValue(0),
      } as unknown as ConstructorParameters<typeof NotificationPreferencesService>[2],
      { loadOrgAvailability: jest.fn().mockResolvedValue(new Set()) } as unknown as ConstructorParameters<typeof NotificationPreferencesService>[3],
    );
    return { svc, captured };
  }

  const ORG = "org-a";
  const USER = "user-1";

  it("writes an OFF rule for every channel when an event is muted", async () => {
    const { svc, captured } = harness();

    await svc.update(ORG, USER, { eventPreferences: { "build.ticket.assigned": { muted: true } } }, 7);

    const rules = captured.inserted.filter((r) => r.scopeType === "EVENT");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.mode === "OFF")).toBe(true);
    expect(rules.every((r) => r.scopeKey === "build.ticket.assigned")).toBe(true);
    // Every delivery channel, or the mute leaks through the ones left unwritten.
    expect(new Set(rules.map((r) => r.channel)).size).toBeGreaterThan(1);
  });

  it("respects an explicit per-channel map rather than muting everything", async () => {
    const { svc, captured } = harness();

    await svc.update(ORG, USER, {
      eventPreferences: { "build.ticket.assigned": { channels: { EMAIL: false, IN_APP: true } } },
    }, 7);

    const rules = captured.inserted.filter((r) => r.scopeType === "EVENT");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ channel: "EMAIL", mode: "OFF" });
    // IN_APP stays ON, which is expressed as absence — a delete, not a row.
    expect(captured.deleted.length).toBeGreaterThan(0);
  });

  it("projects a category switched off", async () => {
    const { svc, captured } = harness();

    await svc.update(ORG, USER, { categories: { SECURITY: false } }, 7);

    const rules = captured.inserted.filter((r) => r.scopeType === "CATEGORY");
    expect(rules.every((r) => r.scopeKey === "SECURITY" && r.mode === "OFF")).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
  });

  it("projects a muted module", async () => {
    const { svc, captured } = harness();

    await svc.update(ORG, USER, { modulePreferences: { crm: { muted: true } } }, 7);

    const rules = captured.inserted.filter((r) => r.scopeType === "MODULE");
    expect(rules.every((r) => r.scopeKey === "crm" && r.mode === "OFF")).toBe(true);
  });

  // ON is absence, not a stored row: persisting the default would freeze a user's
  // preferences against any later change to that default.
  it("deletes rather than storing a row when a preference is turned back on", async () => {
    const { svc, captured } = harness();

    await svc.update(ORG, USER, { categories: { SECURITY: true } }, 7);

    expect(captured.inserted.filter((r) => r.scopeType === "CATEGORY")).toHaveLength(0);
    expect(captured.deleted.length).toBeGreaterThan(0);
  });

  it("writes no rules when the update touches nothing routing reads", async () => {
    const { svc, captured } = harness();

    await svc.update(ORG, USER, { soundEnabled: false }, 7);

    expect(captured.inserted).toHaveLength(0);
    expect(captured.deleted).toHaveLength(0);
  });
});
