const resolveAskOsActor = jest.fn();

jest.mock("./ask-os-actor", () => ({
  resolveAskOsActor: (...args: unknown[]) => resolveAskOsActor(...args),
}));

import { fetchChatContext } from "./chat-assistant-context";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

function boundValues(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) boundValues(child, found);
    return found;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.value === "string") found.push(record.value);
  for (const key of ["queryChunks", "left", "right", "params"])
    if (key in record) boundValues(record[key], found);
  return found;
}

function thenable(rows: readonly unknown[]): object {
  let chain: object;
  chain = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "then")
          return (
            onFulfilled: (value: readonly unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise.resolve(rows).then(onFulfilled, onRejected);
        return () => chain;
      },
    },
  );
  return chain;
}

const IST_TODAY = "2026-03-15";

function makeDb(capture: { where?: unknown }) {
  return {
    query: {
      attendance: {
        findFirst: (args: { where?: unknown }) => {
          capture.where = args.where;
          return Promise.resolve(undefined);
        },
      },
    },
    select: () => thenable([]),
  } as unknown as Db;
}

describe("the assistant's attendance read uses the actor's calendar day, not the server's", () => {
  const caller = {
    userId: "user-1",
    orgId: "org-1",
  } as unknown as CurrentUserContext;

  beforeEach(() => {
    jest.clearAllMocks();
    resolveAskOsActor.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      membershipId: 1,
      displayName: "Asha",
      email: "asha@example.com",
      orgName: "Acme",
      role: "MEMBER",
      isOrgOwner: false,
      timezone: "Asia/Kolkata",
      today: IST_TODAY,
      monthStart: "2026-03-01",
      monthEnd: "2026-03-31",
      currentYear: 2026,
      currentMonth: 3,
    });
  });

  it("binds the actor's zoned today, so a user past midnight in their zone is not read against the server's yesterday", async () => {
    const capture: { where?: unknown } = {};

    await fetchChatContext(makeDb(capture), "user-1", "org-1", caller);

    expect(capture.where).toBeDefined();
    expect(boundValues(capture.where)).toContain(IST_TODAY);
  });

  it("binds exactly one calendar date, so the assertion above cannot pass on a stray literal", async () => {
    const capture: { where?: unknown } = {};

    await fetchChatContext(makeDb(capture), "user-1", "org-1", caller);

    const dates = boundValues(capture.where).filter((value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value),
    );
    expect(dates).toEqual([IST_TODAY]);
  });
});
