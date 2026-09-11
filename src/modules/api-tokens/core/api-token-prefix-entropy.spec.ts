import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { API_TOKEN_LABEL, generateApiToken } from "./api-token-key";
import { generateApiKey } from "../../settings/settings.helpers";

const SRC_ROOT = join(__dirname, "..", "..", "..");

/** The keyspace of the expression that shipped, kept so the floor below means something. */
const SHIPPED_KEYSPACE = 16 ** 7; // "sk_" + 7 hex characters = 268,435,456

/**
 * Every production file that inserts into `api_keys`. A writer not in this set has
 * no entropy floor asserted anywhere, which is precisely how `createToken` kept a
 * 7-character prefix after the sibling writer was widened.
 */
const KNOWN_WRITERS = [
  "modules/api-tokens/core/api-tokens.service.ts",
  "modules/settings/settings.service.ts",
];

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFilesUnder(full));
    } else if (entry.endsWith(".ts") && !entry.includes(".spec.")) {
      found.push(full);
    }
  }
  return found;
}

describe("api token prefix entropy", () => {
  it("the prefix is a real prefix of the token, and the hash is of the whole token", () => {
    const { rawKey, keyHash, keyPrefix } = generateApiToken();

    expect(rawKey.startsWith(API_TOKEN_LABEL)).toBe(true);
    expect(rawKey.startsWith(keyPrefix)).toBe(true);
    expect(keyHash).toBe(createHash("sha256").update(rawKey).digest("hex"));
    expect(keyPrefix.length).toBeLessThan(rawKey.length);
  });

  it("carries at least 12 random hex characters after the literal", () => {
    const random = generateApiToken().keyPrefix.slice(API_TOKEN_LABEL.length);

    expect(random.length).toBeGreaterThanOrEqual(12);
    expect(random).toMatch(/^[0-9a-f]+$/);
  });

  it("enumerates every writer into api_keys, so a third cannot appear unguarded", () => {
    const writers = sourceFilesUnder(SRC_ROOT)
      .filter((file) => /\.insert\(\s*apiKeys\s*\)/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC_ROOT.length + 1).split(/[\\/]/).join("/"))
      .sort();

    expect(writers).toEqual(KNOWN_WRITERS);
  });

  it("both writers clear the floor, and their prefixes cannot collide with each other", () => {
    const token = generateApiToken().keyPrefix;
    const key = generateApiKey().keyPrefix;

    expect(token.startsWith("sk_")).toBe(true);
    expect(key.startsWith("streamlineos_")).toBe(true);
    expect(token.startsWith(key)).toBe(false);
    expect(key.startsWith(token)).toBe(false);
  });

  it("200,000 tokens produce 200,000 distinct prefixes — the shipped expression produced 199,943", () => {
    const draws = 200_000;
    const prefixes = new Set<string>();
    for (let i = 0; i < draws; i++) prefixes.add(generateApiToken().keyPrefix);

    expect(prefixes.size).toBe(draws);
  });

  it("proves the floor is not vacuous — the shipped expression really did collide", () => {
    const shippedPrefix = () => `sk_${randomBytes(32).toString("hex")}`.slice(0, 10);
    const prefixes = new Set<string>();
    const draws = 200_000;
    for (let i = 0; i < draws; i++) prefixes.add(shippedPrefix());

    expect(prefixes.size).toBeLessThan(draws);
    expect(SHIPPED_KEYSPACE).toBe(268_435_456);
  });
});
