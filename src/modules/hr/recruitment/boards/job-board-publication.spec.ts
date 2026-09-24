import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isAdvertised,
  markBlocked,
  markClosed,
  markFailed,
  markLive,
  markQueued,
  PUBLICATION_STATES,
} from "./job-board-publication";

const NOW = new Date("2026-09-24T10:00:00.000Z");

describe("publication states", () => {
  it("only calls an advertisement live when it is LIVE", () => {
    for (const state of PUBLICATION_STATES)
      expect(isAdvertised(state)).toBe(state === "LIVE");
  });

  it("records a blocked board with its code and message, and no posting id", () => {
    expect(markBlocked("needs-keys", "No credentials are saved.")).toMatchObject({
      status: "BLOCKED",
      statusDetail: "needs-keys: No credentials are saved.",
      externalPostingId: null,
      lastAttemptAt: null,
    });
  });

  it("queues without claiming an attempt was made", () => {
    expect(markQueued()).toEqual({ status: "QUEUED", statusDetail: null });
  });

  it("keeps the vendor's own words on a failure, capped", () => {
    const failed = markFailed("x".repeat(900), NOW);
    expect(failed.status).toBe("FAILED");
    expect(failed.statusDetail).toHaveLength(500);
    expect(failed.lastAttemptAt).toBe(NOW);
  });

  it("closes with the reason and a sync stamp", () => {
    expect(markClosed("vendor expired it", NOW)).toMatchObject({
      status: "CLOSED",
      statusDetail: "vendor expired it",
      lastSyncedAt: NOW,
    });
  });

  it("reaches LIVE only with a posting id the vendor supplied", () => {
    expect(markLive("NAU-99", "https://naukri.test/99", NOW)).toMatchObject({
      status: "LIVE",
      externalPostingId: "NAU-99",
      externalPostUrl: "https://naukri.test/99",
      statusDetail: null,
    });
  });
});

/**
 * The structural half of the honesty rule.
 *
 * `markLive` takes `externalPostingId` as a required string, so no caller can
 * reach `LIVE` without one — but only if `markLive` stays the sole producer.
 * This sweep is what stops a later change from writing `status: "LIVE"` into an
 * update object directly, which is precisely how the original defect was
 * written: a literal, in a service, with no vendor behind it.
 */
describe("nothing else in recruitment can write a LIVE publication", () => {
  const RECRUITMENT_SRC = join(__dirname, "..");
  const ALLOWED = ["/boards/job-board-publication.ts"];

  function* sources(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) yield* sources(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) yield full;
    }
  }

  function executable(file: string): string {
    return readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
  }

  it("has exactly one producer of the LIVE status literal", () => {
    const offenders: string[] = [];
    for (const file of sources(RECRUITMENT_SRC)) {
      const relative = file.replace(RECRUITMENT_SRC, "");
      if (ALLOWED.includes(relative)) continue;
      if (/status:\s*"LIVE"/.test(executable(file))) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});
