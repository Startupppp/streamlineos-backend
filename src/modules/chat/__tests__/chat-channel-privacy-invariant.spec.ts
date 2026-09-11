import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Migration 0981 adds CHECK (is_private = (type <> 'PUBLIC')). Every insert path must
 * satisfy it or the write fails at runtime, and the membership guard reads is_private
 * to answer 404 rather than 403 — so a DIRECT or GROUP channel stored as is_private
 * false would answer 403 to a non-member and confirm the conversation exists.
 */
const serviceSource = readFileSync(
  join(__dirname, "..", "chat-channels.service.ts"),
  "utf8",
);

function insertBlocks(source: string): string[] {
  const blocks: string[] = [];
  const re = /\.values\(\{([\s\S]*?)\}\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const body = m[1] ?? "";
    if (body.includes("type:")) blocks.push(body);
  }
  return blocks;
}

describe("chat channel privacy invariant", () => {
  const blocks = insertBlocks(serviceSource);

  it("finds the channel insert sites it is meant to police", () => {
    // A regex that matches nothing would make every assertion below vacuous.
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it("every literal-typed channel insert sets is_private consistently with its type", () => {
    for (const block of blocks) {
      const literal = /type:\s*"(DIRECT|GROUP|PUBLIC|PRIVATE)"/.exec(block);
      if (!literal) continue;
      const type = literal[1];
      const setsPrivateTrue = /isPrivate:\s*true/.test(block);
      if (type === "PUBLIC") expect(setsPrivateTrue).toBe(false);
      else expect(setsPrivateTrue).toBe(true);
    }
  });

  it("the computed branch derives privacy from discoverability, not the PRIVATE label alone", () => {
    expect(serviceSource).toContain('const isPrivate = channelType !== "PUBLIC"');
    expect(serviceSource).not.toContain('const isPrivate = channelType === "PRIVATE"');
  });

  it("the migration backfills before it constrains, so existing rows cannot block it", () => {
    const migration = readFileSync(
      join(__dirname, "..", "..", "..", "..", "migrations", "0981_chat_channel_privacy_invariant.sql"),
      "utf8",
    );
    const update = migration.indexOf("UPDATE \"chat_channels\"");
    const check = migration.indexOf("ADD CONSTRAINT");
    expect(update).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(update);
    expect(migration).toContain("is_private\" = (\"type\" <> 'PUBLIC')");
  });
});
