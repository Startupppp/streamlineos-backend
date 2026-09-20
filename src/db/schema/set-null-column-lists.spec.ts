import * as schema from ".";
import { deriveSetNullDeclarations } from "./set-null-column-lists";

const declarations = () => deriveSetNullDeclarations(schema as Record<string, unknown>);

describe("ON DELETE SET NULL declarations", () => {
  it("declares no SET NULL foreign key whose columns are all non-nullable", () => {
    const offenders = declarations().unreachable.map(
      (fk) => `${fk.table}.${fk.constraint} (${fk.columns.join(", ")})`,
    );
    expect(offenders).toEqual([]);
  });

  it("finds composite SET NULL foreign keys that the catalog must carry a column list for", () => {
    const needList = declarations().declared.filter((fk) => fk.requiresColumnList);
    expect(needList.length).toBeGreaterThan(0);
  });
});
