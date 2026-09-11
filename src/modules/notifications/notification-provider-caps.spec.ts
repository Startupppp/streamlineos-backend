/**
 * `daily_send_limit` and `monthly_cost_limit` were validated, persisted and shown in
 * the admin UI, and read by nothing.
 *
 * A repo-wide grep for either name returned exactly four sites: the schema
 * declaration (`notifications-delivery.ts:170-171`), the DTO
 * (`dto/provider.schemas.ts:29-30`) and the two writes in
 * `NotificationProvidersService`. Zero readers. An operator who set a 10,000/day SMS
 * cap after a runaway loop got 400,000 messages out of the next one, and learned
 * about it from the provider invoice — the product advertised a backpressure control
 * that did not exist, which is worse than offering none. That is the "backpressure"
 * half of PRD-C132.
 */
import { checkProviderCaps, dayStartUtc, monthStartUtc } from "./notification-provider-caps";
import type { Db } from "../../db/drizzle.types";

const NOW = new Date("2026-03-17T09:30:00.000Z");

/** Every bound parameter in a drizzle `sql` fragment, however deeply nested. */
function boundValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined) return [];
  if (value instanceof Date) return [value];
  if (typeof value !== "object") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => boundValues(item, seen));
  if (seen.has(value)) return [];
  seen.add(value);
  const record = value as Record<string, unknown>;
  return [
    ...(Array.isArray(record["queryChunks"]) ? boundValues(record["queryChunks"], seen) : []),
    ...("value" in record ? boundValues(record["value"], seen) : []),
  ];
}

/** A db whose one aggregate answers `value`, recording the predicate it was given. */
function dbReturning(...values: number[]): { db: Db; wheres: unknown[] } {
  const wheres: unknown[] = [];
  let call = 0;
  const db = {
    select: jest.fn((projection: Record<string, unknown>) => ({
      from: jest.fn(() => ({
        where: jest.fn((clause: unknown) => {
          wheres.push(clause);
          const key = Object.keys(projection)[0] ?? "value";
          const value = values[call] ?? 0;
          call += 1;
          return Promise.resolve([{ [key]: value }]);
        }),
      })),
    })),
  } as unknown as Db;
  return { db, wheres };
}

describe("notification provider caps", () => {
  it("counts against UTC window boundaries, stated rather than inherited from the host", () => {
    // A cap that followed the host's zone would reset at a different instant on every
    // machine, and TZ is pinned to a non-UTC zone in this suite precisely to catch it.
    expect(dayStartUtc(NOW).toISOString()).toBe("2026-03-17T00:00:00.000Z");
    expect(monthStartUtc(NOW).toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("issues no query at all when both caps are unset", async () => {
    const { db } = dbReturning(0);

    const verdict = await checkProviderCaps(
      db, "org-1", "SMS", { dailySendLimit: null, monthlyCostLimit: null }, NOW,
    );

    expect(verdict).toEqual({ allowed: true });
    expect(jest.mocked(db.select)).not.toHaveBeenCalled();
  });

  it("allows a send below the daily cap", async () => {
    const { db } = dbReturning(9_999);

    const verdict = await checkProviderCaps(
      db, "org-1", "SMS", { dailySendLimit: 10_000, monthlyCostLimit: null }, NOW,
    );

    expect(verdict).toEqual({ allowed: true });
  });

  it("refuses at the daily cap and asks to be retried after the window turns over", async () => {
    const { db } = dbReturning(10_000);

    const verdict = await checkProviderCaps(
      db, "org-1", "SMS", { dailySendLimit: 10_000, monthlyCostLimit: null }, NOW,
    );

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.reason).toContain("daily send limit reached for SMS");
    // 09:30Z to the next UTC midnight.
    expect(verdict.retryAfterMs).toBe(14.5 * 60 * 60 * 1000);
  });

  it("refuses at the monthly cost cap, and money stays integer minor units", async () => {
    // First aggregate is the daily count (under its cap), second is the month's spend.
    const { db } = dbReturning(1, 250_00);

    const verdict = await checkProviderCaps(
      db, "org-1", "SMS", { dailySendLimit: 10_000, monthlyCostLimit: 250_00 }, NOW,
    );

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.reason).toContain("monthly cost limit reached for SMS (25000/25000)");
    // 2026-03-17T09:30Z to 2026-04-01T00:00Z.
    expect(verdict.retryAfterMs).toBe((14 * 24 + 14.5) * 60 * 60 * 1000);
  });

  it("scopes the count to this organisation and this channel", async () => {
    const { db, wheres } = dbReturning(0);

    await checkProviderCaps(db, "org-1", "WHATSAPP", { dailySendLimit: 5, monthlyCostLimit: null }, NOW);

    const bound = boundValues(wheres[0]).map((v) => (v instanceof Date ? v.toISOString() : v));
    expect(bound).toContain("org-1");
    expect(bound).toContain("WHATSAPP");
    expect(bound).toContain("2026-03-17T00:00:00.000Z");
  });
});
