import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { appendMessageToConversation } from "./chat-conversation-messages";
import type { Db } from "../../../../db/drizzle.module";

/**
 * The cross-tenant write that the chat pre-stream transaction fix made
 * reachable.
 *
 * `appendMessageToConversation` took `conversationId` straight off the request
 * body and keyed its SELECT and both UPDATEs on the bare `id`. With no org
 * predicate, a forged id inserted the caller's message into a stranger's
 * conversation and rewrote that conversation's title with the first 60
 * characters of the caller's prompt. RLS was the only thing standing between a
 * signed-in user of one tenant and another tenant's chat history — and RLS is a
 * backstop, not the authorization.
 */

interface Recorded {
  inserts: number;
  updates: number;
}

function fakeDb(row: { title: string | null } | undefined, recorded: Recorded): Db {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(row === undefined ? [] : [row]),
    insert: () => ({
      values: () => {
        recorded.inserts += 1;
        return Promise.resolve(undefined);
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          recorded.updates += 1;
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
  return chain as unknown as Db;
}

describe("appending to a conversation proves ownership before it writes", () => {
  it("a forged conversation id is a NotFound, not a title rewrite", async () => {
    const recorded: Recorded = { inserts: 0, updates: 0 };

    await expect(
      appendMessageToConversation(
        fakeDb(undefined, recorded),
        "org_attacker",
        "user_attacker",
        7,
        4242,
        "user",
        "steal this conversation",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(recorded.inserts).toBe(0);
    expect(recorded.updates).toBe(0);
  });

  it("a conversation the caller owns is still appended to and titled", async () => {
    const recorded: Recorded = { inserts: 0, updates: 0 };

    await appendMessageToConversation(
      fakeDb({ title: null }, recorded),
      "org_1",
      "user_1",
      7,
      12,
      "user",
      "what is my leave balance",
    );

    expect(recorded.inserts).toBe(1);
    expect(recorded.updates).toBe(1);
  });

  it("an empty message writes nothing at all", async () => {
    const recorded: Recorded = { inserts: 0, updates: 0 };

    await appendMessageToConversation(
      fakeDb({ title: null }, recorded),
      "org_1",
      "user_1",
      7,
      12,
      "user",
      "   ",
    );

    expect(recorded).toEqual({ inserts: 0, updates: 0 });
  });
});

const SRC_ROOT = join(__dirname, "..", "..", "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.includes(".spec.")) out.push(full);
  }
  return out;
}

/** The `.where(...)` argument that encloses `index`, by paren balance. */
function enclosingWhereArgument(source: string, index: number): string | null {
  const marker = ".where(";
  const start = source.lastIndexOf(marker, index);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start + marker.length - 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i > index ? source.slice(start, i + 1) : null;
    }
  }
  return null;
}

/**
 * A corpus scan, not a scan of the files this change happened to touch. It
 * looks at EVERY statement anywhere under `src/` that keys `ai_chat_conversations`
 * by its primary key, so a sixth site added in another module — or a predicate
 * quietly dropped from one of the seven that exist today — fails here rather
 * than shipping as another tenant boundary held up by RLS alone.
 */
describe("every ai_chat_conversations statement is scoped to a tenant", () => {
  const NEEDLE = "eq(aiChatConversations.id,";

  it("finds the sites it claims to guard", () => {
    const files = sourceFiles(SRC_ROOT).filter((f) =>
      readFileSync(f, "utf8").includes(NEEDLE),
    );
    const total = files.reduce(
      (sum, f) => sum + readFileSync(f, "utf8").split(NEEDLE).length - 1,
      0,
    );
    expect(files.length).toBeGreaterThan(0);
    expect(total).toBeGreaterThanOrEqual(7);
  });

  it("never keys the table by id alone", () => {
    const unscoped: string[] = [];

    for (const file of sourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes(NEEDLE)) continue;

      let from = 0;
      for (;;) {
        const at = source.indexOf(NEEDLE, from);
        if (at === -1) break;
        from = at + NEEDLE.length;

        const where = enclosingWhereArgument(source, at);
        const scope = where ?? source.slice(Math.max(0, at - 400), at + 400);
        if (!scope.includes("aiChatConversations.orgId")) {
          const line = source.slice(0, at).split("\n").length;
          unscoped.push(`${file.slice(SRC_ROOT.length + 1)}:${line}`);
        }
      }
    }

    expect(unscoped).toEqual([]);
  });
});
