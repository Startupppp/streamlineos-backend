import { createTicketSchema, updateTicketSchema } from "./ticket.schemas";

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
});
