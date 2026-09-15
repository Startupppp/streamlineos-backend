import {
  ticketWatcherSchema,
  watcherMutationSchema,
} from "./build-tickets-response.schemas";

describe("build ticket watcher response contracts", () => {
  it("accepts the watcher list shape returned by the joined membership query", () => {
    expect(
      ticketWatcherSchema.parse({
        id: 1,
        ticketId: 25,
        createdAt: new Date("2026-09-15T00:00:00.000Z"),
        userId: "user-1",
        user: {
          id: "user-1",
          name: null,
          firstName: "Test",
          lastName: "Owner",
          email: "owner@example.test",
          image: null,
        },
      }),
    ).toMatchObject({ userId: "user-1", ticketId: 25 });
  });

  it("accepts the resource returned when a watcher is added", () => {
    expect(
      watcherMutationSchema.parse({
        userId: "user-1",
        name: null,
        image: null,
        membershipId: 42,
      }),
    ).toEqual({
      userId: "user-1",
      name: null,
      image: null,
      membershipId: 42,
    });
  });
});
