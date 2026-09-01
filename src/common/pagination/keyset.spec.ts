import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { activities } from "../../db/schema";
import {
  keysetAfter,
  keysetAfterId,
  keysetAfterValue,
  keysetBefore,
  keysetBeforeId,
  keysetBeforeValue,
} from "./keyset";

const dialect = new PgDialect();

describe("keyset comparisons", () => {
  const position = { sortValue: "2026-08-20T09:00:00.000Z", id: "act-1" };

  it("compares both columns as one tuple, so a shared timestamp still orders", () => {
    const query = dialect.sqlToQuery(keysetBefore(activities.occurredAt, activities.activityId, position));

    expect(query.sql).toBe(
      '("activities"."occurred_at", "activities"."activity_id") < ($1, $2)',
    );
  });

  it("reads the other direction for a list that walks oldest first", () => {
    const query = dialect.sqlToQuery(keysetAfter(activities.occurredAt, activities.activityId, position));

    expect(query.sql).toContain(") > (");
  });

  /**
   * The defect this helper exists for.
   *
   * A `Date` interpolated straight into a `sql` template reaches postgres-js
   * with no type attached and is serialised as text, which throws. Binding
   * through the column turns it into the driver value the column round-trips.
   */
  it("hands the driver a value it can serialise, not a bare Date", () => {
    const query = dialect.sqlToQuery(keysetBefore(activities.occurredAt, activities.activityId, position));

    expect(query.params[0]).not.toBeInstanceOf(Date);
    expect(typeof query.params[0]).toBe("string");
    expect(query.params[0]).toBe("2026-08-20T09:00:00.000Z");
    expect(query.params[1]).toBe("act-1");
  });

  it("takes a position that already holds a Date", () => {
    const query = dialect.sqlToQuery(
      keysetBefore(activities.occurredAt, activities.activityId, {
        sortValue: new Date("2026-08-20T09:00:00.000Z"),
        id: "act-1",
      }),
    );

    expect(query.params[0]).toBe("2026-08-20T09:00:00.000Z");
  });
});

describe("numeric keyset cursor validation", () => {
  const invalidIds = ["abc", "0", "-1", "1.5", "Infinity", "9007199254740992"];

  it.each(invalidIds)("rejects invalid numeric id %s before building SQL", (id) => {
    const timestampPosition = {
      sortValue: "2026-08-20T09:00:00.000Z",
      id,
    };
    const valuePosition = { sortValue: "alpha", id };

    expect(() =>
      keysetAfterId(activities.occurredAt, activities.activityId, timestampPosition),
    ).toThrow(BadRequestException);
    expect(() =>
      keysetBeforeId(activities.occurredAt, activities.activityId, timestampPosition),
    ).toThrow(BadRequestException);
    expect(() =>
      keysetAfterValue(activities.activityId, activities.activityId, valuePosition),
    ).toThrow(BadRequestException);
    expect(() =>
      keysetBeforeValue(activities.activityId, activities.activityId, valuePosition),
    ).toThrow(BadRequestException);
  });

  it.each(["not-a-date", "2026-99-99", ""])(
    "rejects invalid timestamp %s before building SQL",
    (sortValue) => {
      const position = { sortValue, id: "42" };

      expect(() =>
        keysetAfterId(activities.occurredAt, activities.activityId, position),
      ).toThrow(BadRequestException);
      expect(() =>
        keysetBeforeId(activities.occurredAt, activities.activityId, position),
      ).toThrow(BadRequestException);
    },
  );
});

/**
 * A ratchet, not a style rule.
 *
 * Nine cursor-paginated lists shipped with a bare `Date` interpolated into a
 * `sql` template. Every one of them typechecked, passed its unit tests against a
 * mocked database, and threw on page two against a real one — page one carries
 * no cursor, so nothing below the seam ever ran the broken branch. Grepping for
 * the shape is the only cheap thing that catches the tenth.
 */
describe("no cursor rebuilds a Date inside a sql template", () => {
  const root = join(__dirname, "..", "..");

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : sources(path);
      return path.endsWith(".ts") && !path.endsWith(".spec.ts") ? [path] : [];
    });
  }

  it("finds none", () => {
    const offenders = sources(root).filter((path) =>
      /sql`[^`]*\$\{new Date\(/.test(readFileSync(path, "utf8")),
    );

    expect(offenders.map((path) => path.slice(root.length + 1))).toEqual([]);
  });

  /**
   * The same defect, in the form the rule above cannot see.
   *
   * `${new Date(` only matches a Date built on the spot. Both instances actually
   * in this repository interpolated a variable that already held one —
   * `AutonomyService.loadThread` bound the thread window's upper edge as
   * `<= (${trigger.occurredAt}, …)`, and `claimDueRuns` wrote
   * `lease_expires_at = ${lease}` — so both read as ordinary template
   * interpolation and neither was a cursor rebuild. The first threw on every
   * threaded message and the second on every claim, which meant the durable
   * runtime never ran a workflow at all; both were found by driving the ingress
   * path against a real database, not by this file.
   *
   * So the shape to grep for is the tuple bound rather than the Date: in a
   * keyset comparison the right-hand side is always a value, and a value that
   * does not go through `sql.param` reaches the driver with no type attached.
   */
  it("binds every keyset tuple through sql.param", () => {
    const unbound = /sql`[^`]*\)\s*[<>]=?\s*\(\s*\$\{(?!sql\.param)/;

    // The rule still recognises the shape it exists to catch.
    expect(
      unbound.test(
        "sql`(${activities.occurredAt}, ${activities.activityId}) <= (${trigger.occurredAt}, ${trigger.activityId})`",
      ),
    ).toBe(true);
    expect(
      unbound.test(
        "sql`(${sortColumn}, ${idColumn}) < (${sql.param(at(position), sortColumn)}, ${sql.param(position.id, idColumn)})`",
      ),
    ).toBe(false);

    const offenders = sources(root).filter((path) => unbound.test(readFileSync(path, "utf8")));

    expect(offenders.map((path) => path.slice(root.length + 1))).toEqual([]);
  });
});
