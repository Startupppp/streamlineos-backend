import { TasksCalendarSource } from "./tasks-calendar-source";
import type { CalendarSourceContext } from "../calendar/calendar-event-source";
import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const ctx: CalendarSourceContext = {
  orgId: "org-1",
  userId: "user-1",
  start: new Date("2026-08-01"),
  end: new Date("2026-08-31"),
  scope: "all",
};

function buildDb(tasks: unknown[]): unknown {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(tasks),
      }),
    }),
  };
}

async function buildSource(db: unknown): Promise<TasksCalendarSource> {
  const module = await Test.createTestingModule({
    providers: [
      TasksCalendarSource,
      { provide: DRIZZLE, useValue: db },
    ],
  }).compile();
  return module.get(TasksCalendarSource);
}

describe("TasksCalendarSource", () => {
  it("has the expected key, label and module", () => {
    const source = new TasksCalendarSource(null as never);
    expect(source.key).toBe("tasks");
    expect(source.label).toBe("Tasks");
    expect(source.module).toBe("tasks");
  });

  it("returns an empty array when no tasks exist in the range", async () => {
    const source = await buildSource(buildDb([]));
    const result = await source.load(ctx);
    expect(result).toHaveLength(0);
  });

  it("maps a task with a due date to a projection with category=task and meta.source=task", async () => {
    const dueDate = new Date("2026-08-15");
    const source = await buildSource(
      buildDb([{ id: 42, title: "Fix bug", dueDate, status: "open" }]),
    );
    const result = await source.load(ctx);

    expect(result).toHaveLength(1);
    const proj = result[0];
    expect(proj?.id).toBe("task-42");
    expect(proj?.title).toBe("Fix bug");
    expect(proj?.start).toEqual(dueDate);
    expect(proj?.allDay).toBe(true);
    expect(proj?.category).toBe("task");
    expect(proj?.meta["source"]).toBe("task");
  });

  it("assigns gray color for completed tasks and red for others", async () => {
    const due = new Date("2026-08-10");
    const source = await buildSource(
      buildDb([
        { id: 1, title: "Done", dueDate: due, status: "completed" },
        { id: 2, title: "Open", dueDate: due, status: "open" },
      ]),
    );
    const result = await source.load(ctx);

    expect(result.find((p) => p.id === "task-1")?.color).toBe("gray");
    expect(result.find((p) => p.id === "task-2")?.color).toBe("red");
  });

  it("skips rows where dueDate is null despite the isNotNull filter", async () => {
    const source = await buildSource(
      buildDb([{ id: 10, title: "No due", dueDate: null, status: "open" }]),
    );
    const result = await source.load(ctx);
    expect(result).toHaveLength(0);
  });
});
