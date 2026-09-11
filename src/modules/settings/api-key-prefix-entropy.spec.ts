import { createHash, randomUUID } from "node:crypto";
import { generateApiKey } from "./settings.helpers";

const HEAD_KEYSPACE = 16 ** 3;

describe("api key prefix entropy", () => {
  it("the prefix is a real prefix of the key, and the hash is of the whole key", () => {
    const { rawKey, keyHash, keyPrefix } = generateApiKey();

    expect(rawKey.startsWith("streamlineos_")).toBe(true);
    expect(rawKey.startsWith(keyPrefix)).toBe(true);
    expect(keyHash).toBe(createHash("sha256").update(rawKey).digest("hex"));
    expect(keyPrefix.length).toBeLessThan(rawKey.length);
  });

  it("carries at least 12 random hex characters after the literal", () => {
    const random = generateApiKey().keyPrefix.slice("streamlineos_".length);

    expect(random.length).toBeGreaterThanOrEqual(12);
    expect(random).toMatch(/^[0-9a-f]+$/);
  });

  it("20,000 keys produce 20,000 distinct prefixes — head produced 4,096", () => {
    const draws = 20_000;
    const prefixes = new Set<string>();
    for (let i = 0; i < draws; i++) prefixes.add(generateApiKey().keyPrefix);

    expect(prefixes.size).toBeGreaterThan(HEAD_KEYSPACE);
    expect(prefixes.size).toBeGreaterThanOrEqual(draws - 1);
  });

  it("proves the floor is not vacuous — the head expression really did saturate", () => {
    const headPrefix = () => `streamlineos_${randomUUID().replace(/-/g, "")}`.slice(0, 16);
    const prefixes = new Set<string>();
    for (let i = 0; i < 200_000; i++) prefixes.add(headPrefix());

    expect(prefixes.size).toBe(HEAD_KEYSPACE);
  });
});
