import { InboxConsumer, shouldProcessVersion } from "./inbox-consumer";

describe("shouldProcessVersion", () => {
  it("processes an event when the aggregate has never been applied", () => {
    expect(shouldProcessVersion(null, 1)).toBe(true);
  });

  it("processes an event whose version is newer than the last applied", () => {
    expect(shouldProcessVersion(1, 2)).toBe(true);
  });

  it("skips an event whose version was already applied", () => {
    expect(shouldProcessVersion(2, 2)).toBe(false);
  });

  it("skips a stale event that arrived out of order after a newer one", () => {
    expect(shouldProcessVersion(3, 2)).toBe(false);
  });
});

function makeClaimDb(options: {
  inserted: Array<{ id: number }>;
  existing?: Array<{ status: string; aggregateVersion: number }>;
  latestCompleted?: Array<{ aggregateVersion: number }>;
}) {
  const execute = jest.fn().mockResolvedValue(
    options.inserted.length > 0 ? options.latestCompleted ?? [] : options.existing ?? [],
  );

  const updateWhere = jest.fn().mockResolvedValue([]);
  const set = jest.fn().mockReturnValue({ where: updateWhere });
  const update = jest.fn().mockReturnValue({ set });

  const returning = jest.fn().mockResolvedValue(options.inserted);
  const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });

  return {
    db: { insert, execute, update } as never,
    insert,
    set,
    execute,
  };
}

const event = {
  eventId: "event-1",
  organizationId: "org-1",
  aggregateType: "ticket",
  aggregateId: "ticket-1",
  aggregateVersion: 1,
};

describe("InboxConsumer.claim", () => {
  it("claims a first event when no newer version has completed", async () => {
    const { db, execute } = makeClaimDb({
      inserted: [{ id: 1 }],
      latestCompleted: [{ aggregateVersion: 0 }],
    });

    await expect(new InboxConsumer(db).claim("consumer", event)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("skips a first delivery that arrives after a newer version completed", async () => {
    const { db, set } = makeClaimDb({
      inserted: [{ id: 1 }],
      latestCompleted: [{ aggregateVersion: 2 }],
    });

    await expect(new InboxConsumer(db).claim("consumer", event)).resolves.toBe(false);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SKIPPED", lastError: "out-of-order event" }),
    );
  });

  it("does not re-run a completed event on redelivery", async () => {
    const { db, execute } = makeClaimDb({
      inserted: [],
      existing: [{ status: "COMPLETED", aggregateVersion: 1 }],
    });

    await expect(new InboxConsumer(db).claim("consumer", event)).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
