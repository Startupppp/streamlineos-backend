import { getTableConfig, type IndexColumn } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { SQL } from "drizzle-orm";
import { chatMessages } from "../../../db/schema";
import { CHAT_MESSAGE_CLIENT_KEY_CONFLICT } from "../chat-message-conflict-target";

type ConflictSpec = { target: IndexColumn[]; where?: SQL };

const HEAD_FORM: ConflictSpec = {
  target: [chatMessages.orgId, chatMessages.channelId, chatMessages.clientKey],
};

function clientKeyIndex() {
  const declared = getTableConfig(chatMessages).indexes.find(
    (index) => (index as unknown as { config: { name: string } }).config.name === "uniq_chat_messages_client_key",
  );
  return (declared as unknown as { config: { unique?: boolean; where?: unknown } } | undefined)?.config;
}

describe("chat send conflict target — hermetic", () => {
  it("the index it arbitrates is unique AND partial, which is what makes a bare target 42P10", () => {
    const index = clientKeyIndex();
    expect(index).toBeDefined();
    expect(index?.unique).toBe(true);
    expect(index?.where).toBeDefined();
  });

  it("the production conflict spec emits an arbiter predicate, and the head form does not", () => {
    const offline = drizzle(postgres("postgres://unused@127.0.0.1:1/unused", { max: 1 }));
    const compile = (config: ConflictSpec) =>
      offline
        .insert(chatMessages)
        .values({ orgId: "o", channelId: 1, content: "x", clientKey: "k", channelPosition: 0 })
        .onConflictDoNothing(config)
        .toSQL().sql;

    const shipped = compile(CHAT_MESSAGE_CLIENT_KEY_CONFLICT);
    const head = compile(HEAD_FORM);

    expect(head).toContain(`on conflict ("org_id","channel_id","client_key") do nothing`);
    expect(shipped).toMatch(/on conflict \("org_id","channel_id","client_key"\) where .*client_key.* do nothing/);
    expect(shipped).not.toContain(`"client_key") do nothing`);
  });

  it("spells the arbiter predicate the key onConflictDoNothing actually reads", () => {
    expect(Object.keys(CHAT_MESSAGE_CLIENT_KEY_CONFLICT).sort()).toEqual(["target", "where"]);
  });
});
