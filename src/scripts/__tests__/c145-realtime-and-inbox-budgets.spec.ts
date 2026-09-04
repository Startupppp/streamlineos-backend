import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * PRD-C145 — "Prove Chat, Calendar, Inbox and Notifications list, unread/count, range/history
 * and realtime-token paths meet their budgets without table scans, N+1 or per-item
 * cache/database calls."
 *
 * WHAT WAS WRONG. Four of the named paths had no budget of any kind. `contracts/route-budgets.json`
 * held 93 entries and NONE of them matched `/ably|token/`, so neither realtime-token route carried a
 * ceiling; `GET /me/inbox/unified` and `GET /me/inbox/unified/count` were likewise undeclared. A
 * path with no declared ceiling cannot breach one — "meets its budget" was an assumption, not a
 * measurement, and `check-route-budgets.mjs` had nothing to report on for any of the four.
 *
 * WHY THIS SPEC. The link between a route budget and the read-cost budget that measures it is what
 * makes the ceiling enforceable, and nothing else asserts that these four routes are in it. This
 * spec pins the whole chain per route: the route budget exists, its `readCostBudgetId` resolves to a
 * real read-cost budget, that budget forbids a sequential scan on the growing relation, it bounds
 * the rows the plan may touch, and the manifest carries a real measurement rather than a null. Any
 * one of those going away is the defect coming back.
 *
 * It does NOT re-measure — `run-read-cost-budgets.mjs` does that against the seeded database and is
 * the instrument this spec points at. Deleting the budget, breaking the link, dropping the
 * seq-scan assertion or blanking the measurement all fail here without a database.
 */

const BACKEND_ROOT = resolve(__dirname, "..", "..", "..");

interface RouteBudget {
  readCostBudgetId?: string;
  maxDbCalls?: number;
  maxLatencyP95Ms?: number;
  measuredBufferBlocks?: number | null;
  measurement?: { status?: string; readCostOutcome?: string; resultRows?: number } | null;
}

interface ReadCostBudget {
  id: string;
  ceiling: number;
  maxScanRows?: number;
  sql: string;
  planAssertions: { kind: string; relation?: string }[];
}

/**
 * `read-cost-budgets.mjs` is a native ES module and this suite runs under ts-jest's CommonJS
 * transform, which cannot require() one. Reading the declarations out of a short-lived `node`
 * process keeps the spec pinned to the budgets the GATE loads rather than to a copy of them.
 */
function loadReadCostBudgets(): ReadCostBudget[] {
  const modulePath = resolve(BACKEND_ROOT, "src", "scripts", "read-cost-budgets.mjs");
  const program = `
    import { BUDGETS } from ${JSON.stringify(modulePath)};
    process.stdout.write(JSON.stringify(BUDGETS.map((b) => ({
      id: b.id, ceiling: b.ceiling, maxScanRows: b.maxScanRows ?? null,
      sql: String(b.sql ?? ""), planAssertions: b.planAssertions ?? [],
    }))));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    cwd: BACKEND_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out) as ReadCostBudget[];
}

function loadRouteBudgets(): Record<string, RouteBudget> {
  const raw = readFileSync(resolve(BACKEND_ROOT, "contracts", "route-budgets.json"), "utf8");
  return (JSON.parse(raw) as { budgets: Record<string, RouteBudget> }).budgets;
}

/**
 * The route, the read-cost budget that measures it, and the relation whose sequential scan is the
 * defect. The relation is the GROWING side in every case — `chat_channels` is 56 rows on the
 * reference seed, where a sequential read is the planner's correct choice, so asserting against it
 * would pin table size rather than plan shape.
 */
const C145_PATHS = [
  {
    route: "GET /chat/ably-token",
    readCostBudgetId: "chat-realtime-token-channel-ids",
    relation: "chat_channel_members",
    clause: "realtime-token",
  },
  {
    route: "GET /support/ably-token",
    readCostBudgetId: "support-realtime-token-ticket-ids",
    relation: "support_tickets",
    clause: "realtime-token",
  },
  {
    route: "GET /me/inbox/unified",
    readCostBudgetId: "inbox-unified-notifications-page",
    relation: "notifications",
    clause: "Inbox list",
  },
  {
    route: "GET /me/inbox/unified/count",
    readCostBudgetId: "inbox-unified-unread-count",
    relation: "notifications",
    clause: "Inbox unread/count",
  },
] as const;

describe("PRD-C145 realtime-token and unified-inbox budgets", () => {
  const routeBudgets = loadRouteBudgets();
  const readCost = new Map(loadReadCostBudgets().map((b) => [b.id, b]));

  it.each(C145_PATHS)("$route carries a declared budget ($clause)", ({ route }) => {
    const entry = routeBudgets[route];
    expect(entry).toBeDefined();
    expect(typeof entry?.maxDbCalls).toBe("number");
    expect(typeof entry?.maxLatencyP95Ms).toBe("number");
  });

  it.each(C145_PATHS)("$route links to a read-cost budget that exists", ({ route, readCostBudgetId }) => {
    expect(routeBudgets[route]?.readCostBudgetId).toBe(readCostBudgetId);
    expect(readCost.get(readCostBudgetId)).toBeDefined();
  });

  it.each(C145_PATHS)(
    "$readCostBudgetId forbids a sequential scan on $relation",
    ({ readCostBudgetId, relation }) => {
      const budget = readCost.get(readCostBudgetId);
      expect(budget?.planAssertions).toContainEqual({ kind: "forbid-seq-scan", relation });
    },
  );

  it.each(C145_PATHS)("$readCostBudgetId bounds the rows its plan may touch", ({ readCostBudgetId }) => {
    const budget = readCost.get(readCostBudgetId);
    expect(typeof budget?.ceiling).toBe("number");
    const bounded =
      typeof budget?.maxScanRows === "number" || /\bLIMIT\b/i.test(budget?.sql ?? "");
    expect(bounded).toBe(true);
  });

  it.each(C145_PATHS)("$route carries a real measurement, not a null", ({ route }) => {
    const entry = routeBudgets[route];
    expect(entry?.measurement?.status).toBe("measured");
    expect(entry?.measurement?.readCostOutcome).toBe("pass");
    expect(typeof entry?.measuredBufferBlocks).toBe("number");
  });

  it.each(C145_PATHS)("$route measures a non-empty result set", ({ route }) => {
    expect(routeBudgets[route]?.measurement?.resultRows).toBeGreaterThan(0);
  });

  /**
   * The two realtime-token reads are bounded at the DATABASE, not at the consumer. Before the fix
   * the chat one selected every non-archived channel row for the membership and
   * `AblyService.createChatTokenRequest` threw 49,500 of 50,000 away in memory.
   */
  it("both realtime-token reads carry a LIMIT in the measured statement", () => {
    for (const id of ["chat-realtime-token-channel-ids", "support-realtime-token-ticket-ids"])
      expect(readCost.get(id)?.sql).toMatch(/\bLIMIT\s+\d+/i);
  });
});
