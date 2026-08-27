import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { attributeConversion } from "./attribution-projection";
import type { AttributionTouch, Conversion } from "./attribution-touch";

/**
 * The guard behind ticket 18's fifth criterion.
 *
 * "Changing the model does not rewrite history; it re-presents it" is a claim
 * about storage, and it survives exactly as long as nobody adds a credits table.
 * The day somebody does — for a dashboard that felt slow, most likely — a model
 * change starts having two possible meanings, and whichever one is chosen, one
 * of last quarter's reports becomes a lie.
 *
 * `attribution-projection.ts` argues the case in prose. This is the part that
 * fails the build. It is the same technique the legacy-reader ratchet and the
 * cross-region enumeration use: the property cannot be expressed in the type
 * system, so it is asserted over the source.
 *
 * A cache would not violate this — a cache is derived, keyed by model, and
 * thrown away. A TABLE of credits would, because it outlives the model that
 * produced it and nothing makes it agree with the next one.
 */
describe("attribution stores nothing it would have to rewrite", () => {
  const MODULE_DIR = "src/modules/attribution";

  /** Comments here discuss inserts constantly; only code performs one. */
  const executable = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

  /** Every way this module could begin to persist a credit. */
  const WRITES = [
    /\.insert\s*\(/,
    /\.update\s*\(/,
    /\.delete\s*\(/,
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+"?[a-z_]+"?\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bpgTable\s*\(/,
  ] as const;

  /**
   * This file names every write it looks for, so it matches itself by
   * construction. Excluding it is not a loophole — nothing in here persists
   * anything, and the alternative is a guard that can never be written down.
   */
  const SELF = `${MODULE_DIR}/attribution-is-a-projection.spec.ts`;

  function moduleFiles(): string[] {
    return execSync(`git ls-files --cached --others --exclude-standard -- "${MODULE_DIR}"`, {
      encoding: "utf8",
    })
      .split("\n")
      .filter((file) => file && file.endsWith(".ts") && file !== SELF && existsSync(file));
  }

  it("has files to check, so a rename cannot silence this", () => {
    // A guard that scans nothing passes forever. If this fails, the module moved
    // and MODULE_DIR needs to move with it.
    expect(moduleFiles().length).toBeGreaterThan(0);
  });

  it("performs no write and declares no table", () => {
    const writers = moduleFiles().filter((file) => {
      const source = executable(readFileSync(file, "utf8"));
      return WRITES.some((pattern) => pattern.test(source));
    });

    // Attribution is a reading of `activities` and `deals`. If a figure needs to
    // be faster, cache it keyed by model and throw the cache away — do not give
    // a credit a row, because a row outlives the model that produced it.
    expect(writers).toEqual([]);
  });

  it("gives a credit nothing that only a stored row would need", () => {
    const conversion: Conversion = {
      dealId: "1",
      organizationId: "org-1",
      currency: "GBP",
      valueMinor: 1_000,
      convertedAt: new Date("2026-02-01T00:00:00.000Z"),
    };
    const touch: AttributionTouch = {
      activityId: "activity-1",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      kind: "call",
      channel: "manual",
      partyId: "party-1",
      dealId: "1",
    };

    const [credit] = attributeConversion(conversion, [touch], "linear").credits;

    /*
      A credit's identity IS the activity it came from. An id of its own, or a
      timestamp saying when it was written, would only be needed by a row — and
      whichever of these appeared first would be the beginning of the table this
      whole file exists to prevent.
    */
    expect(Object.keys(credit).sort()).toEqual([
      "activityId",
      "channel",
      "creditBps",
      "creditMinor",
      "kind",
      "occurredAt",
    ]);
  });
});
