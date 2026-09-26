import { ClientAccountsService } from "./client-accounts.service";
import { ScopedRead } from "../access/scoped-read";
import { MembershipResolvingDispatchDouble } from "../notifications/notification-recipient-membership.spec-fixtures";

const registerAfterCommit = jest.fn();

jest.mock("../../common/tenant/tenant-context", () => ({
  ...jest.requireActual("../../common/tenant/tenant-context"),
  registerAfterCommit: (...args: unknown[]) => registerAfterCommit(...args),
}));

/**
 * Flattens a drizzle `SQL` back to the literal text its template carried.
 *
 * The assertion below is about a cast written into that template, so the
 * parameters are irrelevant and only the `StringChunk` values matter — but
 * recursing over everything is simpler than distinguishing chunk classes and
 * cannot miss a chunk a future drizzle version nests differently.
 */
function sqlText(value: unknown, seen = new Set<object>()): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => sqlText(item, seen)).join("");
  if (typeof value !== "object" || value === null || seen.has(value)) return "";
  seen.add(value);
  const rec = value as { queryChunks?: unknown; value?: unknown };
  return [
    rec.queryChunks === undefined ? "" : sqlText(rec.queryChunks, seen),
    Object.prototype.hasOwnProperty.call(rec, "value") ? sqlText(rec.value, seen) : "",
  ].join("");
}

interface Harness {
  service: ClientAccountsService;
  execute: jest.Mock;
  findMany: jest.Mock;
  dispatch: MembershipResolvingDispatchDouble;
}

function makeHarness(): Harness {
  const execute = jest.fn().mockResolvedValue(undefined);
  const findMany = jest.fn().mockResolvedValue([]);
  const countChain = {
    then: (fn: (v: unknown) => unknown) => Promise.resolve([{ count: 0 }]).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve([{ count: 0 }]).catch(fn),
    finally: (fn: () => void) => Promise.resolve([{ count: 0 }]).finally(fn),
  };
  const db = {
    execute,
    query: { clientAccounts: { findMany } },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(countChain) }),
    }),
  };
  const access = { membersWithPermission: jest.fn().mockResolvedValue([]) };
  const dispatch = new MembershipResolvingDispatchDouble([]);
  const service = new ClientAccountsService(
    db as never,
    null,
    {} as never,
    {} as never,
    access as never,
    dispatch as never,
  );
  return { service, execute, findMany, dispatch };
}

describe("client account backfill — the statement that aborted GET /clients", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerAfterCommit.mockReturnValue(false);
  });

  /**
   * `'ACCOUNT_OPENING'::text` was the root failure. `client_accounts.status` is
   * the enum `client_account_status`, and Postgres has no assignment cast from
   * `text` to an enum, so the INSERT died 42804 during parse — before execution,
   * so it failed even for an organisation with nothing to backfill. Because the
   * whole request runs in one tenant transaction, that aborted it and every
   * later statement of the list read answered 25P02.
   */
  it("casts the seeded status to the enum, never to text", async () => {
    const { service, execute } = makeHarness();

    await service.getClientAccounts(ScopedRead.of("org-1", "user-1", "all"), {} as never);

    expect(execute).toHaveBeenCalled();
    const statement = sqlText(execute.mock.calls[0]?.[0]);
    expect(statement).toContain("'ACCOUNT_OPENING'::client_account_status");
    expect(statement).not.toContain("'ACCOUNT_OPENING'::text");
  });

  it("defers the backfill past commit instead of writing inside the read's transaction", async () => {
    const { service, execute } = makeHarness();
    let hook: (() => Promise<void>) | undefined;
    registerAfterCommit.mockImplementation((candidate) => {
      hook = candidate as () => Promise<void>;
      return true;
    });

    await service.getClientAccounts(ScopedRead.of("org-1", "user-1", "all"), {} as never);

    expect(registerAfterCommit).toHaveBeenCalledTimes(1);
    expect(hook).toBeDefined();
    expect(execute).not.toHaveBeenCalled();

    await hook?.();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  /**
   * The old `catch` logged a warning and returned, so the first failure was
   * invisible and only its 25P02 shadow reached anyone. A deferred failure must
   * reach the after-commit handler, which logs it at error and reports it.
   */
  it("does not swallow a backfill failure", async () => {
    const { service, execute } = makeHarness();
    execute.mockRejectedValue(new Error("insert exploded"));
    let hook: (() => Promise<void>) | undefined;
    registerAfterCommit.mockImplementation((candidate) => {
      hook = candidate as () => Promise<void>;
      return true;
    });

    await service.getClientAccounts(ScopedRead.of("org-1", "user-1", "all"), {} as never);

    await expect(hook?.()).rejects.toThrow("insert exploded");
  });

  it("runs the backfill inline when there is no ambient transaction to defer past", async () => {
    const { service, execute } = makeHarness();

    await service.getClientAccounts(ScopedRead.of("org-1", "user-1", "all"), {} as never);

    expect(registerAfterCommit).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
