import {
  allWorkQuerySchema,
  createTicketSchema,
  searchTicketsQuerySchema,
  ticketsListQuerySchema,
  updateTicketSchema,
} from "./ticket.schemas";

describe("Build ticket numeric bounds", () => {
  it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid story points on create: %s",
    (points) => {
      expect(createTicketSchema.safeParse({ title: "Valid ticket", points }).success).toBe(false);
    },
  );

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid story points on update: %s",
    (points) => {
      expect(updateTicketSchema.safeParse({ points }).success).toBe(false);
    },
  );

  it.each([-0.01, Number.POSITIVE_INFINITY])(
    "rejects invalid original estimates on create: %s",
    (originalEstimate) => {
      expect(createTicketSchema.safeParse({ title: "Valid ticket", originalEstimate }).success).toBe(false);
    },
  );

  it.each([-0.01, Number.POSITIVE_INFINITY])(
    "rejects invalid original estimates on update: %s",
    (originalEstimate) => {
      expect(updateTicketSchema.safeParse({ originalEstimate }).success).toBe(false);
    },
  );

  it.each([0, 8])("accepts valid story points: %s", (points) => {
    expect(createTicketSchema.safeParse({ title: "Valid ticket", points }).success).toBe(true);
    expect(updateTicketSchema.safeParse({ points }).success).toBe(true);
  });

  it.each([0, 0.25, 100])("accepts valid original estimates: %s", (originalEstimate) => {
    expect(createTicketSchema.safeParse({ title: "Valid ticket", originalEstimate }).success).toBe(true);
    expect(updateTicketSchema.safeParse({ originalEstimate }).success).toBe(true);
  });

  it.each([ticketsListQuerySchema, allWorkQuerySchema])("accepts ISO due-date filters", (schema) => {
    expect(schema.safeParse({ dueDateFrom: "2026-08-01", dueDateTo: "2026-08-31" }).success).toBe(true);
  });

  it.each([ticketsListQuerySchema, allWorkQuerySchema])("rejects non-date due-date filters", (schema) => {
    expect(schema.safeParse({ dueDateFrom: "soon", dueDateTo: "2026/08/31" }).success).toBe(false);
  });

  it.each([ticketsListQuerySchema, allWorkQuerySchema])("rejects a reversed due-date range", (schema) => {
    expect(schema.safeParse({ dueDateFrom: "2026-09-01", dueDateTo: "2026-08-31" }).success).toBe(false);
  });

  it.each([ticketsListQuerySchema, allWorkQuerySchema])("rejects malformed CSV filters instead of dropping invalid values", (schema) => {
    expect(schema.safeParse({ status: "TODO,,DONE" }).success).toBe(false);
    expect(schema.safeParse({ priority: "HIGH,NOT_A_PRIORITY" }).success).toBe(false);
    expect(schema.safeParse({ type: "BUG,NOT_A_TYPE" }).success).toBe(false);
    expect(schema.safeParse({ labelIds: "1,not-a-number" }).success).toBe(false);
    expect(schema.safeParse({ cycleId: "0,2" }).success).toBe(false);
  });

  it.each([ticketsListQuerySchema, allWorkQuerySchema])("preserves valid CSV filters", (schema) => {
    const result = schema.safeParse({
      status: "TODO, DONE",
      priority: "HIGH,URGENT",
      type: "BUG,TASK",
      labelIds: "1,2",
      cycleId: "7,8",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toEqual(["TODO", "DONE"]);
    expect(result.data.priority).toEqual(["HIGH", "URGENT"]);
    expect(result.data.type).toEqual(["BUG", "TASK"]);
    expect(result.data.labelIds).toEqual([1, 2]);
    expect(result.data.cycleId).toEqual([7, 8]);
  });

  it.each([ticketsListQuerySchema, allWorkQuerySchema])("rejects oversized search terms and trims valid terms", (schema) => {
    expect(schema.safeParse({ search: "x".repeat(201) }).success).toBe(false);
    const result = schema.safeParse({ search: "  login  " });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.search).toBe("login");
  });

  it("bounds the organization search endpoint too", () => {
    expect(searchTicketsQuerySchema.safeParse({ q: "x".repeat(201) }).success).toBe(false);
    expect(searchTicketsQuerySchema.parse({ q: "  login  " }).q).toBe("login");
  });
});
