import {
  allWorkQuerySchema,
  createTicketSchema,
  searchTicketsQuerySchema,
  ticketsListQuerySchema,
  updateTicketSchema,
} from "./ticket.schemas";

describe("ticket type derives from the database enum", () => {
  it.each(["EPIC", "STORY", "TASK", "BUG"])(
    "createTicketSchema accepts DB enum value: %s",
    (type) => {
      expect(createTicketSchema.safeParse({ title: "Valid ticket", type }).success).toBe(true);
    },
  );

  it.each(["SUBTASK", "subtask", "FEATURE", "", "null"])(
    "createTicketSchema rejects value absent from the DB enum: %s",
    (type) => {
      expect(createTicketSchema.safeParse({ title: "Valid ticket", type }).success).toBe(false);
    },
  );

  it.each(["EPIC", "STORY", "TASK", "BUG"])(
    "updateTicketSchema accepts DB enum value: %s",
    (type) => {
      expect(updateTicketSchema.safeParse({ version: 1, type }).success).toBe(true);
    },
  );

  it.each(["SUBTASK", "subtask", "FEATURE", "", "null"])(
    "updateTicketSchema rejects value absent from the DB enum: %s",
    (type) => {
      expect(updateTicketSchema.safeParse({ version: 1, type }).success).toBe(false);
    },
  );

  it("updateTicketSchema accepts omitted type (field is optional)", () => {
    expect(updateTicketSchema.safeParse({ version: 1 }).success).toBe(true);
  });

  it("updateTicketSchema rejects a body with no version, so every rejection above is attributable to the field under test and not to the missing concurrency token", () => {
    expect(updateTicketSchema.safeParse({ type: "TASK" }).success).toBe(false);
    expect(updateTicketSchema.safeParse({ version: 1, type: "TASK" }).success).toBe(true);
  });
});

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
      expect(updateTicketSchema.safeParse({ version: 1, points }).success).toBe(false);
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
      expect(updateTicketSchema.safeParse({ version: 1, originalEstimate }).success).toBe(false);
    },
  );

  it.each([0, 8])("accepts valid story points: %s", (points) => {
    expect(createTicketSchema.safeParse({ title: "Valid ticket", points }).success).toBe(true);
    expect(updateTicketSchema.safeParse({ version: 1, points }).success).toBe(true);
  });

  it.each([0, 0.25, 100])("accepts valid original estimates: %s", (originalEstimate) => {
    expect(createTicketSchema.safeParse({ title: "Valid ticket", originalEstimate }).success).toBe(true);
    expect(updateTicketSchema.safeParse({ version: 1, originalEstimate }).success).toBe(true);
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

  it("accepts positive All Work product and team filters", () => {
    const result = allWorkQuerySchema.safeParse({ managedProductId: "12", teamId: "34" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.managedProductId).toBe(12);
    expect(result.data.teamId).toBe(34);
  });

  it("rejects non-positive All Work product and team filters", () => {
    expect(allWorkQuerySchema.safeParse({ managedProductId: "0" }).success).toBe(false);
    expect(allWorkQuerySchema.safeParse({ teamId: "-1" }).success).toBe(false);
  });

  it("accepts the documented personal relation scopes", () => {
    for (const scope of ["mentioned", "blocked", "recently-completed"] as const) {
      expect(allWorkQuerySchema.safeParse({ scope }).success).toBe(true);
    }
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
