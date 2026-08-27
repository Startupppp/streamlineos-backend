import { compileQuery, QueryDescriptionError, type Requester } from "../query/query-compiler";
import { QUERY_BOUNDS } from "../query/query-bounds";
import type { QueryDescription } from "../query/query-description";
import { QUERY_GRAPH } from "../query/query-graph";
import { builderCatalogue } from "./builder-catalogue";

const WHO: Requester = { orgId: "org-acme", userId: "user-1", scope: "all" };
const catalogue = builderCatalogue();

/**
 * Ticket 13's last criterion is "building a report requires no engineering
 * involvement, which is the measure of this ticket". That is not directly
 * testable, but its most common failure is: the builder offers a choice the
 * compiler refuses, and the person who picked it raises a ticket.
 *
 * So this is a round-trip property rather than a set of examples — every single
 * combination the catalogue offers is compiled, and any refusal fails the build.
 * It is the difference between "we checked the ones we thought of" and "there is
 * no offer that does not work".
 */
describe("everything the builder offers, the compiler accepts", () => {
  it("offers something to build with", () => {
    expect(catalogue.entities.length).toBeGreaterThan(0);
    for (const entity of catalogue.entities) expect(entity.fields.length).toBeGreaterThan(0);
  });

  it("compiles every field on every entity as a selection", () => {
    for (const entity of catalogue.entities)
      for (const field of entity.fields)
        expect(() =>
          compileQuery({ entity: entity.key, select: [field.key] }, WHO),
        ).not.toThrow();
  });

  it("compiles every operator offered for every field", () => {
    const sampleFor = (type: string, values?: readonly string[]): unknown => {
      if (type === "number") return 1;
      if (type === "boolean") return true;
      if (type === "enum") return values?.[0];
      if (type === "date") return "2026-01-01";
      return "sample";
    };

    for (const entity of catalogue.entities)
      for (const field of entity.fields)
        for (const operator of field.operators) {
          const value = sampleFor(field.type, field.values);
          const description: QueryDescription = {
            entity: entity.key,
            filters: [
              operator === "isNull" || operator === "isNotNull"
                ? { field: field.key, operator }
                : operator === "in"
                  ? { field: field.key, operator, value: [value as string] }
                  : { field: field.key, operator, value: value as string },
            ],
          };
          try {
            compileQuery(description, WHO);
          } catch (error) {
            throw new Error(
              `catalogue offers ${entity.key}.${field.key} ${operator}, which the compiler refused: ${
                (error as Error).message
              }`,
            );
          }
        }
  });

  it("compiles every aggregation offered for every field", () => {
    for (const entity of catalogue.entities)
      for (const field of entity.fields)
        for (const of_ of field.aggregations) {
          const description: QueryDescription = {
            entity: entity.key,
            aggregations: [
              of_ === "count"
                ? { of: of_, as: "n" }
                : { of: of_, field: field.key, as: "n" },
            ],
          };
          expect(() => compileQuery(description, WHO)).not.toThrow();
        }
  });

  it("compiles every declared join, with a field from the joined entity", () => {
    for (const entity of catalogue.entities)
      for (const join of entity.joins) {
        const target = QUERY_GRAPH[join.entity];
        expect(target).toBeDefined();
        const someField = Object.keys(target!.fields)[0]!;
        expect(() =>
          compileQuery(
            { entity: entity.key, joins: [join.key], select: [`${join.key}.${someField}`] },
            WHO,
          ),
        ).not.toThrow();
      }
  });

  it("compiles every offered grouping", () => {
    for (const entity of catalogue.entities)
      for (const field of catalogue.entities.find((e) => e.key === entity.key)!.fields)
        if (field.groupable)
          expect(() =>
            compileQuery(
              { entity: entity.key, groupBy: [field.key], aggregations: [{ of: "count", as: "n" }] },
              WHO,
            ),
          ).not.toThrow();
  });
});

describe("the builder does not offer what a report may not have", () => {
  it("omits sensitive fields rather than showing them and refusing", () => {
    const deals = catalogue.entities.find((e) => e.key === "deals")!;
    expect(deals.fields.map((f) => f.key)).not.toContain("notes");
    // ...and the compiler still refuses it, so the omission is a courtesy
    // rather than the enforcement.
    expect(() => compileQuery({ entity: "deals", select: ["notes"] }, WHO)).toThrow(
      QueryDescriptionError,
    );
  });

  it("omits entities that cannot be the root of a report", () => {
    // `users` is global identity, reachable only through a join.
    expect(catalogue.entities.map((e) => e.key)).not.toContain("users");
    expect(() => compileQuery({ entity: "users" }, WHO)).toThrow(
      /only be reported through a related record/,
    );
  });

  it("does not offer text operators on a number, or ordering on an enum", () => {
    const deals = catalogue.entities.find((e) => e.key === "deals")!;
    const value = deals.fields.find((f) => f.key === "value")!;
    expect(value.operators).not.toContain("contains");

    const parties = catalogue.entities.find((e) => e.key === "parties")!;
    const kind = parties.fields.find((f) => f.key === "partyKind")!;
    expect(kind.operators).not.toContain("gt");
    expect(kind.values).toEqual(["PERSON", "ORGANISATION"]);
  });

  it("does not offer summing a date", () => {
    const deals = catalogue.entities.find((e) => e.key === "deals")!;
    const createdAt = deals.fields.find((f) => f.key === "createdAt")!;
    expect(createdAt.aggregations).not.toContain("sum");
    expect(createdAt.aggregations).toContain("max");
  });

  it("does not offer grouping by a field that would return one row per record", () => {
    const deals = catalogue.entities.find((e) => e.key === "deals")!;
    expect(deals.fields.find((f) => f.key === "id")!.groupable).toBe(false);
    expect(deals.fields.find((f) => f.key === "name")!.groupable).toBe(false);
    expect(deals.fields.find((f) => f.key === "stage")!.groupable).toBe(true);
  });

  it("states the bounds up front rather than only on submit", () => {
    // Ticket 14's fourth criterion, read as a product requirement: a person
    // should know the ceiling before they design a report against it.
    expect(catalogue.bounds).toBe(QUERY_BOUNDS);
    expect(catalogue.bounds.maxRowsReturned).toBe(1_000);
  });

  it("offers a stage filter that is not a frozen list of five", () => {
    /*
      The regression this file exists to prevent, in its most expensive form. A
      tenant configures its own pipeline stages; the graph used to freeze five of
      them, so the two that ship with every new organisation — CONTACTED and
      NEGOTIATION — could not be filtered on, and neither could any custom stage.
      A builder that cannot express a tenant's own vocabulary is a builder that
      generates support tickets.
    */
    const stage = catalogue.entities
      .find((e) => e.key === "deals")!
      .fields.find((f) => f.key === "stage")!;
    expect(stage.type).toBe("string");
    expect(stage.values).toBeUndefined();
    for (const value of ["LEAD", "CONTACTED", "PROPOSAL", "NEGOTIATION", "WON", "LOST", "Bespoke"])
      expect(() =>
        compileQuery({ entity: "deals", filters: [{ field: "stage", operator: "eq", value }] }, WHO),
      ).not.toThrow();
  });
});
