import {
  EXIT_CHECKLIST_KIND_DEFAULTS,
  exitAnchorDay,
  kindOfItemKey,
  planExitChecklist,
  shiftIsoDay,
} from "./exit-checklist.defaults";
import { EXIT_CHECKLIST_KINDS } from "./dto/exit-checklist.schemas";

const anchor = { lastWorkingDate: "2026-10-31", noticePeriodDays: 30, createdAt: new Date("2026-09-21T10:00:00Z") };

describe("planExitChecklist — the one offboarding checklist every exit gets", () => {
  it("seeds every typed item once, each with an owner rule and a due date anchored on the last working date", () => {
    const planned = planExitChecklist(anchor, []);

    expect(planned.map((item) => item.itemKey)).toEqual([...EXIT_CHECKLIST_KINDS]);
    for (const item of planned) expect(item.owner).toBeDefined();
    expect(planned.find((item) => item.kind === "manager_handover")?.dueDate).toBe("2026-10-24");
    expect(planned.find((item) => item.kind === "it_access_removal")?.dueDate).toBe("2026-10-31");
    expect(planned.find((item) => item.kind === "final_settlement")?.dueDate).toBe("2026-11-30");
  });

  it("routes the handover to the reporting line, IT removal to the identity queue, assets to the assets queue and settlement to the final settlement queue", () => {
    expect(EXIT_CHECKLIST_KIND_DEFAULTS.manager_handover.owner).toEqual({ type: "manager" });
    expect(EXIT_CHECKLIST_KIND_DEFAULTS.it_access_removal.owner).toEqual({ type: "queue", permission: "hr:identity:manage" });
    expect(EXIT_CHECKLIST_KIND_DEFAULTS.asset_return.owner).toEqual({ type: "queue", permission: "hr:assets:manage" });
    expect(EXIT_CHECKLIST_KIND_DEFAULTS.final_settlement.owner).toEqual({ type: "queue", permission: "hr:payroll:approve" });
    expect(EXIT_CHECKLIST_KIND_DEFAULTS.hr_clearance.owner).toEqual({ type: "queue", permission: "hr:exit:manage" });
  });

  it("absorbs the legacy template rows that named a typed item, keeping only their due offset, instead of seeding a second copy", () => {
    const planned = planExitChecklist(anchor, [
      { id: "a1", title: "Process final settlement (FNF)", assigneeRole: "hr", dueOffsetDays: 14 },
      { id: "a2", title: "Revoke access to all systems (email, HRMS)", assigneeRole: "it", dueOffsetDays: 1 },
      { id: "a3", title: "Hand over pending work and documentation", assigneeRole: "employee", dueOffsetDays: 0 },
    ]);

    expect(planned.filter((item) => item.kind === "custom")).toHaveLength(0);
    expect(planned.find((item) => item.kind === "final_settlement")?.dueDate).toBe("2026-11-14");
    expect(planned.find((item) => item.kind === "it_access_removal")?.dueDate).toBe("2026-11-01");
    expect(planned.find((item) => item.kind === "manager_handover")?.owner).toEqual({ type: "manager" });
  });

  it("keeps a template row the typed spine does not cover as a custom item owned by the role's queue, the manager or the leaver", () => {
    const planned = planExitChecklist(anchor, [
      { id: "c1", title: "Collect resignation letter", assigneeRole: "hr", dueOffsetDays: -20 },
      { id: "c2", title: "Update org chart and reporting structure", assigneeRole: "manager", dueOffsetDays: 0 },
      { id: "c3", title: "Return parking pass", assigneeRole: "employee", dueOffsetDays: 0 },
      { title: "Unmapped legacy row", assigneeRole: "unknown-role" },
    ]);
    const custom = planned.filter((item) => item.kind === "custom");

    expect(custom.map((item) => item.itemKey)).toEqual(["custom-c1", "custom-c2", "custom-c3", "custom-template-4"]);
    expect(custom[0]).toMatchObject({ dueDate: "2026-10-11", owner: { type: "queue", permission: "hr:exit:manage" } });
    expect(custom[1]?.owner).toEqual({ type: "manager" });
    expect(custom[2]?.owner).toEqual({ type: "leaver" });
    expect(custom[3]?.owner).toEqual({ type: "queue", permission: "hr:exit:manage" });
  });

  it("falls back to submission date plus notice period when no last working date was given", () => {
    expect(exitAnchorDay({ lastWorkingDate: null, noticePeriodDays: 30, createdAt: new Date("2026-09-21T23:30:00Z") })).toBe("2026-10-21");
  });

  it("does calendar arithmetic in UTC so the host timezone cannot shift a due date by a day", () => {
    expect(shiftIsoDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftIsoDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => shiftIsoDay("31/12/2026", 1)).toThrow();
  });

  it("classifies a key as its typed kind or as custom", () => {
    expect(kindOfItemKey("asset_return")).toBe("asset_return");
    expect(kindOfItemKey("custom-ab12")).toBe("custom");
    expect(kindOfItemKey("custom-9")).toBe("custom");
  });
});
