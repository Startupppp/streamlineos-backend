import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { activities, attendance } from "../../db/schema";
import {
  keysetAfter,
  keysetAfterId,
  keysetAfterTuple,
  keysetAfterValue,
  keysetBefore,
  keysetBeforeId,
  keysetBeforeTuple,
  keysetBeforeUuid,
  keysetBeforeValue,
  keysetInteger,
  keysetTextValue,
  keysetTimestamp,
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

describe("UUID keyset cursor validation", () => {
  it.each(["not-a-uuid", "00000000-0000-0000-0000-000000000000", ""]) (
    "rejects invalid UUID id %s before building SQL",
    (id) => {
      expect(() =>
        keysetBeforeUuid(activities.occurredAt, activities.activityId, {
          sortValue: "2026-08-20T09:00:00.000Z",
          id,
        }),
      ).toThrow(BadRequestException);
    },
  );

  it("accepts a valid UUID tie-breaker", () => {
    expect(() =>
      keysetBeforeUuid(activities.occurredAt, activities.activityId, {
        sortValue: "2026-08-20T09:00:00.000Z",
        id: "0198d510-9d64-7f53-8bd6-aef1c1b695d2",
      }),
    ).not.toThrow();
  });
});

describe("multi-column keyset", () => {
  /**
   * The shape three HR lists needed: a sort of two non-unique columns plus the
   * serial id. Rendering it through PgDialect is the only assertion that sees
   * the tuple — walking the Drizzle object would pass on a comparison that
   * names one column.
   */
  it("renders every column on the left and every value on the right, in order", () => {
    const query = dialect.sqlToQuery(
      keysetBeforeTuple([
        { column: attendance.date, value: keysetTextValue("2026-08-20") },
        { column: attendance.createdAt, value: keysetTimestamp("2026-08-20T09:00:00.000Z") },
        { column: attendance.id, value: keysetInteger("41") },
      ]),
    );

    expect(query.sql).toBe(
      '("attendance"."date", "attendance"."created_at", "attendance"."id") < ($1, $2, $3)',
    );
    expect(query.params).toEqual(["2026-08-20", "2026-08-20T09:00:00.000Z", 41]);
  });

  it("binds the timestamp through its column rather than as a bare Date", () => {
    const query = dialect.sqlToQuery(
      keysetBeforeTuple([
        { column: attendance.date, value: keysetTextValue("2026-08-20") },
        { column: attendance.createdAt, value: keysetTimestamp("2026-08-20T09:00:00.000Z") },
        { column: attendance.id, value: keysetInteger("41") },
      ]),
    );

    expect(query.params[1]).not.toBeInstanceOf(Date);
    expect(typeof query.params[1]).toBe("string");
  });

  it("reads the other direction for a list that walks ascending", () => {
    const query = dialect.sqlToQuery(
      keysetAfterTuple([
        { column: attendance.date, value: keysetTextValue("2026-08-20") },
        { column: attendance.id, value: keysetInteger("41") },
      ]),
    );

    expect(query.sql).toContain(") > (");
  });

  it("refuses a single-column tuple, which is not a keyset", () => {
    expect(() =>
      keysetBeforeTuple([{ column: attendance.id, value: keysetInteger("41") }]),
    ).toThrow(BadRequestException);
  });

  it.each(["", "not-a-date", "2026-13-99T99:99:99Z"])(
    "rejects %p as a timestamp rather than letting the driver throw on page two",
    (raw) => {
      expect(() => keysetTimestamp(raw)).toThrow(BadRequestException);
    },
  );

  it.each(["", "1.5", "abc", "9007199254740993"])(
    "rejects %p as an integer position",
    (raw) => {
      expect(() => keysetInteger(raw)).toThrow(BadRequestException);
    },
  );

  it("accepts zero and negative integer positions, which are legitimate sort orders", () => {
    expect(keysetInteger("0")).toBe(0);
    expect(keysetInteger("-3")).toBe(-3);
  });

  it("caps a text position so a cursor cannot carry a payload", () => {
    expect(() => keysetTextValue("")).toThrow(BadRequestException);
    expect(() => keysetTextValue("x".repeat(513))).toThrow(BadRequestException);
    expect(keysetTextValue("Offer Letter")).toBe("Offer Letter");
  });
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

  /**
   * The type-directed checker for this exact defect carries the shape as a string
   * inside its own self-test fixture — and carries the SAFE `.toISOString()` form
   * at that. Excluding it keeps the grep pointed at production code; the checker's
   * own correctness is asserted by `check:date-in-sql-template:self-test`.
   */
  const CHECKER = join("scripts", "check-date-in-sql-template.ts");

  it("finds none", () => {
    const offenders = sources(root).filter(
      (path) =>
        !path.endsWith(CHECKER) && /sql`[^`]*\$\{new Date\(/.test(readFileSync(path, "utf8")),
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
