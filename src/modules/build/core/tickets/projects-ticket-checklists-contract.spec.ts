import { checklistItemSchema } from "../dto/build-tickets-response.schemas";
import { toChecklistItemRow } from "./projects-ticket-checklists.service";

const ROW = {
  id: 11,
  orgId: "org-1",
  checklistId: 4,
  text: "Write the migration",
  isCompleted: false,
  assigneeId: "user-1" as string | null,
  assigneeMembershipId: null,
  dueDate: "2026-09-30" as string | null,
  order: 2,
  createdAt: new Date("2026-09-15T10:00:00.000Z"),
};

describe("checklist item responses use the field names the table, the request DTO and the client all use", () => {
  it("answers text, not title", () => {
    expect(toChecklistItemRow(ROW).text).toBe("Write the migration");
  });

  it("answers order, not position", () => {
    expect(toChecklistItemRow(ROW).order).toBe(2);
  });

  it("carries the assignee the column stores", () => {
    expect(toChecklistItemRow(ROW).assigneeId).toBe("user-1");
  });

  it("carries the due date the column stores", () => {
    expect(toChecklistItemRow(ROW).dueDate).toBe("2026-09-30");
  });

  it("answers null for an unassigned item with no due date", () => {
    const row = toChecklistItemRow({ ...ROW, assigneeId: null, dueDate: null });

    expect(row.assigneeId).toBeNull();
    expect(row.dueDate).toBeNull();
  });

  it("satisfies the declared response schema", () => {
    expect(() => checklistItemSchema.parse(toChecklistItemRow(ROW))).not.toThrow();
  });
});
