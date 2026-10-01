import { createTicketSchema } from "./ticket.schemas";

describe("createTicketSchema — dueDate acceptance (#179)", () => {
  it("accepts a YYYY-MM-DD due date alongside the required fields", () => {
    const result = createTicketSchema.safeParse({
      title: "Fix login bug",
      type: "TASK",
      dueDate: "2026-10-15",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a full ISO datetime in dueDate — the field must be date-only", () => {
    const result = createTicketSchema.safeParse({
      title: "Fix login bug",
      type: "TASK",
      dueDate: "2026-10-15T09:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a ticket with no dueDate — the field is optional", () => {
    const result = createTicketSchema.safeParse({
      title: "Fix login bug",
      type: "TASK",
    });
    expect(result.success).toBe(true);
  });
});
