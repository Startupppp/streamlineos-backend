import {
  NO_REMINDERS,
  daysBetween,
  dueDateFor,
  reminderDue,
  reminderRulesSchema,
  resolveReminderRules,
} from "../dto/reminder-rules.schemas";

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Kolkata";
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("reminderRulesSchema", () => {
  it("accepts a complete rule set", () => {
    const parsed = reminderRulesSchema.parse({
      enabled: true,
      remindBeforeDueDays: [3, 1],
      remindAfterDueDays: [1, 7],
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.remindBeforeDueDays).toEqual([3, 1]);
  });

  it("defaults both lists so a caller can enable reminders and add days later", () => {
    expect(reminderRulesSchema.parse({ enabled: true })).toEqual({
      enabled: true,
      remindBeforeDueDays: [],
      remindAfterDueDays: [],
    });
  });

  it("rejects an unknown key rather than storing a typo that disables a reminder", () => {
    expect(() =>
      reminderRulesSchema.parse({ enabled: true, remindBeforeDays: [3] }),
    ).toThrow();
  });

  it("bounds the lists, because each entry is a notification per period per day", () => {
    expect(() =>
      reminderRulesSchema.parse({ enabled: true, remindBeforeDueDays: [1, 2, 3, 4, 5, 6] }),
    ).toThrow();
    expect(() =>
      reminderRulesSchema.parse({ enabled: true, remindBeforeDueDays: [31] }),
    ).toThrow();
    expect(() =>
      reminderRulesSchema.parse({ enabled: true, remindAfterDueDays: [-1] }),
    ).toThrow();
  });
});

describe("resolveReminderRules", () => {
  it("reads an unset column as no reminders, not as malformed", () => {
    expect(resolveReminderRules(null)).toEqual({ rules: NO_REMINDERS, malformed: false });
    expect(resolveReminderRules(undefined)).toEqual({ rules: NO_REMINDERS, malformed: false });
  });

  it("reports legacy junk as malformed instead of throwing", () => {
    for (const junk of [42, "on", { every: "friday" }, [], { enabled: "yes" }]) {
      const resolved = resolveReminderRules(junk);
      expect(resolved.malformed).toBe(true);
      expect(resolved.rules).toEqual(NO_REMINDERS);
    }
  });

  it("treats malformed rules as silence, so a bad row cannot spam anyone", () => {
    expect(resolveReminderRules({ enabled: "yes" }).rules.enabled).toBe(false);
  });
});

describe("date arithmetic", () => {
  it("counts whole days regardless of the host timezone", () => {
    expect(daysBetween("2026-03-01", "2026-03-08")).toBe(7);
    expect(daysBetween("2026-03-08", "2026-03-01")).toBe(-7);
    expect(daysBetween("2026-03-01", "2026-03-01")).toBe(0);
  });

  it("crosses a month and a DST boundary without drifting", () => {
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-02-27", "2026-03-02")).toBe(3);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("adds the submission grace to the period end", () => {
    expect(dueDateFor("2026-03-31", 5)).toBe("2026-04-05");
    expect(dueDateFor("2026-03-31", 0)).toBe("2026-03-31");
    expect(dueDateFor("2026-03-31", null)).toBe("2026-03-31");
  });
});

describe("reminderDue", () => {
  const rules = reminderRulesSchema.parse({
    enabled: true,
    remindBeforeDueDays: [3, 1],
    remindAfterDueDays: [1, 7],
  });

  it("says nothing at all when reminders are disabled", () => {
    const off = reminderRulesSchema.parse({
      enabled: false,
      remindBeforeDueDays: [3],
      remindAfterDueDays: [1],
    });
    expect(reminderDue(off, "2026-04-05", "2026-04-02")).toBeNull();
  });

  it("fires on the configured days before the due date and no others", () => {
    expect(reminderDue(rules, "2026-04-05", "2026-04-02")).toBe("DUE_SOON");
    expect(reminderDue(rules, "2026-04-05", "2026-04-04")).toBe("DUE_SOON");
    expect(reminderDue(rules, "2026-04-05", "2026-04-03")).toBeNull();
    expect(reminderDue(rules, "2026-04-05", "2026-03-20")).toBeNull();
  });

  it("fires on the configured days after, which is a different message", () => {
    expect(reminderDue(rules, "2026-04-05", "2026-04-06")).toBe("OVERDUE");
    expect(reminderDue(rules, "2026-04-05", "2026-04-12")).toBe("OVERDUE");
    expect(reminderDue(rules, "2026-04-05", "2026-04-08")).toBeNull();
  });

  it("says nothing on the due date itself unless a rule names day zero", () => {
    expect(reminderDue(rules, "2026-04-05", "2026-04-05")).toBeNull();

    const onTheDay = reminderRulesSchema.parse({ enabled: true, remindAfterDueDays: [0] });
    expect(reminderDue(onTheDay, "2026-04-05", "2026-04-05")).toBe("OVERDUE");
  });

  it("prefers OVERDUE when both lists claim the due date", () => {
    const both = reminderRulesSchema.parse({
      enabled: true,
      remindBeforeDueDays: [0],
      remindAfterDueDays: [0],
    });
    expect(reminderDue(both, "2026-04-05", "2026-04-05")).toBe("OVERDUE");
  });
});
