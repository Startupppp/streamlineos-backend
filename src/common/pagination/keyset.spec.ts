import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { activities } from "../../db/schema";
import { keysetAfter, keysetBefore } from "./keyset";

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
});
