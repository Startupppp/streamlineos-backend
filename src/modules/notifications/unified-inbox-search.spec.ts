import { and, eq } from "drizzle-orm";
import {
  escapeLikeTerm,
  fetchNotificationItems,
} from "./unified-inbox-sources";
import { DEFAULT_INBOX_FILTERS } from "./unified-inbox-sources";
import { notifications } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

function sqlText(v: unknown, seen = new Set<object>()): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined || typeof v !== "object") return "";
  if (seen.has(v)) return "";
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  const chunks = Array.isArray(r.queryChunks)
    ? r.queryChunks.map((c) => sqlText(c, seen)).join(" ")
    : "";
  const value = Object.prototype.hasOwnProperty.call(r, "value")
    ? sqlText(r.value, seen)
    : "";
  return `${chunks} ${value}`;
}

function captureWhere() {
  const captured: unknown[] = [];
  const chain = {
    where: jest.fn().mockImplementation((w: unknown) => {
      captured.push(w);
      return chain;
    }),
    orderBy: jest.fn().mockImplementation(() => chain),
    limit: jest.fn().mockResolvedValue([]),
    leftJoin: jest.fn().mockImplementation(() => chain),
  };
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue(chain),
    }),
  } as unknown as Db;
  return { db, captured };
}

describe("unified inbox notification search is applied in SQL", () => {
  it("pushes the search term into the query so the page limit counts matching rows", async () => {
    const { db, captured } = captureWhere();

    await fetchNotificationItems(db, "org-1", 11, 26, null, false, {
      ...DEFAULT_INBOX_FILTERS,
      q: "invoice",
    });

    expect(captured.length).toBe(1);
    const text = sqlText(captured[0]);
    expect(text.split("%invoice%").length - 1).toBe(2);
  });

  it("adds no search predicate when no term is supplied", async () => {
    const { db, captured } = captureWhere();

    await fetchNotificationItems(db, "org-1", 11, 26, null, false, {
      ...DEFAULT_INBOX_FILTERS,
      q: undefined,
    });

    expect(sqlText(captured[0])).not.toContain("%");
  });

  it("adds no search predicate for a whitespace-only term", async () => {
    const { db, captured } = captureWhere();

    await fetchNotificationItems(db, "org-1", 11, 26, null, false, {
      ...DEFAULT_INBOX_FILTERS,
      q: "   ",
    });

    expect(sqlText(captured[0])).not.toContain("%");
  });

  it("still scopes the search to the caller's org and membership", async () => {
    const { db, captured } = captureWhere();

    await fetchNotificationItems(db, "org-1", 11, 26, null, false, {
      ...DEFAULT_INBOX_FILTERS,
      q: "invoice",
    });

    const text = sqlText(captured[0]);
    expect(text).toContain("org-1");
    expect(text).toContain("11");
  });
});

describe("escapeLikeTerm neutralises wildcards a user types", () => {
  it("escapes a percent so a search for it does not match everything", () => {
    expect(escapeLikeTerm("100%")).toBe("100\\%");
  });

  it("escapes an underscore so it does not match an arbitrary character", () => {
    expect(escapeLikeTerm("a_b")).toBe("a\\_b");
  });

  it("escapes a backslash so the escape character itself is literal", () => {
    expect(escapeLikeTerm("a\\b")).toBe("a\\\\b");
  });

  it("leaves an ordinary term untouched", () => {
    expect(escapeLikeTerm("invoice")).toBe("invoice");
  });
});

describe("drizzle predicate helpers stay importable for the search path", () => {
  it("builds a conjunction over the notifications table", () => {
    const predicate = and(eq(notifications.orgId, "org-1"));
    expect(sqlText(predicate)).toContain("org-1");
  });
});
