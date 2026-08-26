import {
  isHidable,
  RECORD_LAYOUTS,
  RECORD_LAYOUT_KEYS,
  layoutByKey,
} from "./record-layout-catalog";

/**
 * The catalogue is the boundary. If it drifts, the boundary moves without
 * anybody deciding to move it.
 *
 * These assert the properties the service and the schemas assume rather than
 * restating the field lists, which would be the same list typed twice and would
 * drift in the same direction as whatever broke it.
 */
describe("the published record layout catalogue", () => {
  const entries = Object.entries(RECORD_LAYOUTS);

  it("publishes the twelve record types the renderer registry declares", () => {
    // The frontend's `RECORD_LAYOUTS` in `lib/renderer/registry.ts`, key for
    // key. The two catalogues must not drift; this is the half that can be
    // checked from here.
    expect([...RECORD_LAYOUT_KEYS].sort()).toEqual(
      [
        "crm:activity",
        "crm:call-log",
        "crm:campaign",
        "crm:client",
        "crm:company",
        "crm:contact",
        "crm:deal",
        "crm:lead",
        "crm:lead-activity",
        "crm:quote",
        "crm:task",
        "party",
      ].sort(),
    );
  });

  it.each(entries)("%s names a title field it actually declares", (_key, layout) => {
    expect(layout.fields).toContain(layout.titleField);
  });

  it.each(entries)("%s marks required only fields it declares", (_key, layout) => {
    for (const field of layout.required) expect(layout.fields).toContain(field);
  });

  it.each(entries)("%s declares no field twice", (_key, layout) => {
    expect(new Set(layout.fields).size).toBe(layout.fields.length);
  });

  it.each(entries)("%s leaves something hidable", (key, layout) => {
    // A layout where every field is required or titles the record would make the
    // settings screen a page of disabled checkboxes.
    expect([key, layout.fields.some((field) => isHidable(layout, field))]).toEqual([key, true]);
  });

  it("refuses to hide the title field or a required one, for every layout", () => {
    for (const [, layout] of entries) {
      expect(isHidable(layout, layout.titleField)).toBe(false);
      for (const field of layout.required) expect(isHidable(layout, field)).toBe(false);
    }
  });

  it("treats a field it has never heard of as unhidable rather than as absent", () => {
    // `isHidable` is asked about names that arrived in a request body, so
    // "unknown" must not fall through to "not the title and not required".
    expect(isHidable(layoutByKey("crm:lead")!, "salary")).toBe(false);
  });

  describe("the usage sources", () => {
    const withUsage = entries.filter(([, layout]) => layout.usage !== null);

    it("gives most layouts somewhere to count", () => {
      expect(withUsage.length).toBeGreaterThan(entries.length / 2);
    });

    /**
     * Every identifier in the usage query is interpolated with `sql.raw`, so the
     * catalogue is the only thing standing between it and the database. Nothing
     * here comes from a request — but a future edit could paste something that
     * does, and this is where that would be caught.
     */
    const SAFE = /^[A-Za-z0-9_. ()'>|,:*=<-]+$/;

    it.each(withUsage)("%s names only plain SQL identifiers", (key, layout) => {
      const source = layout.usage!;
      expect([key, /^[a-z_][a-z0-9_]*$/.test(source.table)]).toEqual([key, true]);
      expect([key, /^[a-z_][a-z0-9_]*$/.test(source.orgColumn)]).toEqual([key, true]);
      expect([key, /^[a-z_][a-z0-9_]*$/.test(source.orderColumn)]).toEqual([key, true]);
      for (const expression of Object.values(source.columns))
        expect([key, expression, SAFE.test(expression)]).toEqual([key, expression, true]);
    });

    it.each(withUsage)("%s contains no statement terminator or comment", (key, layout) => {
      const source = layout.usage!;
      const all = [...Object.values(source.columns), ...source.filters].join(" ");
      expect([key, all.includes(";"), all.includes("--"), all.includes("/*")]).toEqual([
        key,
        false,
        false,
        false,
      ]);
    });

    it.each(withUsage)("%s counts only fields the layout declares", (key, layout) => {
      for (const field of Object.keys(layout.usage!.columns))
        expect([key, field, layout.fields.includes(field)]).toEqual([key, field, true]);
    });

    it.each(withUsage)("%s can count the field its records are titled by", (key, layout) => {
      // A proposal orders by fill rate with the title pinned first. A title
      // field nothing can count for would be reported as never filled.
      expect([key, Object.keys(layout.usage!.columns)]).toEqual([
        key,
        expect.arrayContaining([layout.titleField]),
      ]);
    });
  });
});
