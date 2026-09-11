import { z } from "zod";
import {
  PAGE_SIZE_CAP,
  baseListQuerySchema,
  optionalPageNumberField,
  optionalPageSizeField,
  pageNumberField,
  pageSizeField,
  withSortField,
} from "./list-query.schema";
import { listProjectsSchema } from "../../modules/build/core/dto/project-core.schemas";
import { listProjectCustomersSchema } from "../../modules/build/core/dto/projects-customers.schemas";
import { listWorkspaceMembersSchema } from "../../modules/build/core/dto/projects-workspace-members.schemas";
import {
  roadmapListQuerySchema,
  feedbackListQuerySchema,
  changelogListQuerySchema,
} from "../../modules/build/core/dto/roadmap.schemas";
import {
  timeEntriesListQuerySchema,
  teamTimesheetsQuerySchema,
} from "../../modules/build/execution/dto/timesheets.schemas";
import { listManagedProductsQuerySchema } from "../../modules/build/managed-products/dto/managed-products.schemas";
import {
  listWorkspacesQuerySchema,
  listMembersQuerySchema,
} from "../../modules/build/pm-workspaces/dto/pm-workspaces.schemas";
import { listPortfoliosQuerySchema } from "../../modules/build/portfolios/dto/portfolios.schemas";
import {
  listTeamsQuerySchema,
  listTeamMembersQuerySchema,
} from "../../modules/build/teams/dto/teams.schemas";
import { listInvoicesSchema } from "../../modules/invoices/dto/invoice.schemas";
import { listSchema as listQuotesSchema } from "../../modules/quotes/dto/quote.schemas";
import { campaignListSchema } from "../../modules/crm/core/dto/campaigns.schemas";
import {
  organizationListSchema,
  orgDuplicatesQuerySchema,
} from "../../modules/crm/core/dto/organizations.schemas";
import { searchTicketsQuerySchema } from "../../modules/build/core/dto/ticket.schemas";
import { intakeListQuerySchema } from "../../modules/build/execution/dto/workspace.schemas";
import { territoryListSchema } from "../../modules/crm/core/dto/territories.schemas";
import {
  listMessagesQuerySchema as chatListMessagesQuerySchema,
  searchQuerySchema as chatSearchQuerySchema,
} from "../../modules/chat/dto/chat.schemas";
import { listMessagesQuerySchema as mailListMessagesQuerySchema } from "../../modules/mail/dto/mail-schemas";
import { searchQuerySchema as globalSearchQuerySchema } from "../../modules/search/dto/search.schemas";

describe("PAGE_SIZE_CAP", () => {
  it("is 100", () => {
    expect(PAGE_SIZE_CAP).toBe(100);
  });
});

describe("pageNumberField", () => {
  it("defaults to 1 when absent", () => {
    expect(pageNumberField.parse(undefined)).toBe(1);
  });

  it("accepts a valid page number", () => {
    expect(pageNumberField.parse(5)).toBe(5);
  });

  it("coerces a string to a number", () => {
    expect(pageNumberField.parse("3")).toBe(3);
  });

  it("rejects 0", () => {
    expect(() => pageNumberField.parse(0)).toThrow();
  });

  it("rejects negative numbers", () => {
    expect(() => pageNumberField.parse(-1)).toThrow();
  });

  it("rejects non-numeric input", () => {
    expect(() => pageNumberField.parse("abc")).toThrow();
  });
});

describe("pageSizeField", () => {
  it("clamps values above the cap to 100, not rejects", () => {
    expect(pageSizeField().parse(999)).toBe(100);
    expect(pageSizeField().parse(101)).toBe(100);
    expect(pageSizeField().parse(100)).toBe(100);
  });

  it("honours values at or below the cap", () => {
    expect(pageSizeField().parse(50)).toBe(50);
    expect(pageSizeField().parse(1)).toBe(1);
  });

  it("applies the provided default when absent", () => {
    expect(pageSizeField(25).parse(undefined)).toBe(25);
    expect(pageSizeField(9).parse(undefined)).toBe(9);
    expect(pageSizeField(20).parse(undefined)).toBe(20);
  });

  it("uses 50 as default when no argument is given", () => {
    expect(pageSizeField().parse(undefined)).toBe(50);
  });

  it("rejects non-numeric input", () => {
    expect(() => pageSizeField().parse("abc")).toThrow();
  });

  it("rejects 0", () => {
    expect(() => pageSizeField().parse(0)).toThrow();
  });
});

describe("optionalPageSizeField", () => {
  const schema = z.object({ limit: optionalPageSizeField() });

  it("stays undefined when absent, so a call site's own default still applies", () => {
    expect(schema.parse({}).limit).toBeUndefined();
  });

  it("clamps an over-large size rather than rejecting it", () => {
    expect(schema.parse({ limit: 999 }).limit).toBe(100);
  });

  it("honours a tighter ceiling", () => {
    expect(z.object({ limit: optionalPageSizeField(50) }).parse({ limit: 999 }).limit).toBe(50);
  });

  it("coerces a string, as a query parameter always is", () => {
    expect(schema.parse({ limit: "25" }).limit).toBe(25);
  });

  it("still refuses zero and negatives", () => {
    expect(() => schema.parse({ limit: 0 })).toThrow();
    expect(() => schema.parse({ limit: -1 })).toThrow();
  });
});

describe("optionalPageNumberField", () => {
  const schema = z.object({ page: optionalPageNumberField() });

  it("stays undefined when absent", () => {
    expect(schema.parse({}).page).toBeUndefined();
  });

  it("accepts a page number", () => {
    expect(schema.parse({ page: 3 }).page).toBe(3);
  });

  it("refuses 0 and negatives", () => {
    expect(() => schema.parse({ page: 0 })).toThrow();
    expect(() => schema.parse({ page: -2 })).toThrow();
  });
});

describe("baseListQuerySchema", () => {
  it("page defaults to 1 when absent", () => {
    expect(baseListQuerySchema.parse({}).page).toBe(1);
  });

  it("limit defaults to 50 when absent", () => {
    expect(baseListQuerySchema.parse({}).limit).toBe(50);
  });

  it("clamps limit above 100", () => {
    expect(baseListQuerySchema.parse({ limit: 200 }).limit).toBe(100);
  });

  it("supports .omit({ cursor, sortDir }) as ticketsListQuerySchema uses", () => {
    const schema = baseListQuerySchema.omit({ cursor: true, sortDir: true });
    const result = schema.parse({ page: "2", limit: "10" });
    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
    expect("cursor" in result).toBe(false);
    expect("sortDir" in result).toBe(false);
  });

  it("supports .omit({ page, sortDir }) as ticketActivityQuerySchema uses", () => {
    const schema = baseListQuerySchema.omit({ page: true, sortDir: true });
    const result = schema.parse({ limit: "15", cursor: "abc" });
    expect(result.limit).toBe(15);
    expect(result.cursor).toBe("abc");
    expect("page" in result).toBe(false);
  });

  it("supports .extend() to add extra fields", () => {
    const schema = baseListQuerySchema
      .omit({ cursor: true, sortDir: true })
      .extend({ search: z.string().optional() });
    const result = schema.parse({ search: "hello" });
    expect(result.search).toBe("hello");
    expect(result.page).toBe(1);
  });
});

describe("withSortField", () => {
  const schema = withSortField(["created", "updated", "priority"]);

  it("accepts a listed sort field", () => {
    expect(schema.parse({ sortField: "created" }).sortField).toBe("created");
  });

  it("refuses an unlisted sort field", () => {
    expect(() => schema.parse({ sortField: "arbitrary_column" })).toThrow();
  });

  it("allows sortField to be absent", () => {
    expect(schema.parse({}).sortField).toBeUndefined();
  });
});

type SizeKey = "limit" | "pageSize";
type ParseableSchema = { parse: (v: unknown) => Record<string, unknown> };

interface SchemaCaseConfig {
  name: string;
  schema: ParseableSchema;
  sizeKey: SizeKey;
  defaultSize: number;
  /** Only where the endpoint keeps a ceiling tighter than the platform cap. */
  ceiling?: number;
}

const schemaCases: SchemaCaseConfig[] = [
  { name: "listProjectsSchema", schema: listProjectsSchema as ParseableSchema, sizeKey: "limit", defaultSize: 9 },
  { name: "listProjectCustomersSchema", schema: listProjectCustomersSchema as ParseableSchema, sizeKey: "limit", defaultSize: 20 },
  { name: "listWorkspaceMembersSchema", schema: listWorkspaceMembersSchema as ParseableSchema, sizeKey: "limit", defaultSize: 20 },
  { name: "roadmapListQuerySchema", schema: roadmapListQuerySchema as ParseableSchema, sizeKey: "limit", defaultSize: 50 },
  { name: "feedbackListQuerySchema", schema: feedbackListQuerySchema as ParseableSchema, sizeKey: "limit", defaultSize: 50 },
  { name: "changelogListQuerySchema", schema: changelogListQuerySchema as ParseableSchema, sizeKey: "limit", defaultSize: 50 },
  { name: "timeEntriesListQuerySchema", schema: timeEntriesListQuerySchema as ParseableSchema, sizeKey: "limit", defaultSize: 50 },
  { name: "teamTimesheetsQuerySchema", schema: teamTimesheetsQuerySchema as ParseableSchema, sizeKey: "limit", defaultSize: 50 },
  { name: "listManagedProductsQuerySchema", schema: listManagedProductsQuerySchema as ParseableSchema, sizeKey: "limit", defaultSize: 20 },
  { name: "listWorkspacesQuerySchema", schema: listWorkspacesQuerySchema as ParseableSchema, sizeKey: "limit", defaultSize: 20 },
  { name: "listMembersQuerySchema", schema: listMembersQuerySchema as ParseableSchema, sizeKey: "limit", defaultSize: 20 },
  { name: "listPortfoliosQuerySchema", schema: listPortfoliosQuerySchema as ParseableSchema, sizeKey: "limit", defaultSize: 20 },
  { name: "listTeamsQuerySchema", schema: listTeamsQuerySchema as ParseableSchema, sizeKey: "pageSize", defaultSize: 50 },
  { name: "listTeamMembersQuerySchema", schema: listTeamMembersQuerySchema as ParseableSchema, sizeKey: "pageSize", defaultSize: 50 },
  { name: "listInvoicesSchema", schema: listInvoicesSchema as ParseableSchema, sizeKey: "limit", defaultSize: 50 },
  { name: "listQuotesSchema", schema: listQuotesSchema as ParseableSchema, sizeKey: "pageSize", defaultSize: 25 },
  { name: "campaignListSchema", schema: campaignListSchema as ParseableSchema, sizeKey: "limit", defaultSize: 20, ceiling: 50 },
  { name: "organizationListSchema", schema: organizationListSchema as ParseableSchema, sizeKey: "pageSize", defaultSize: 20 },
  { name: "orgDuplicatesQuerySchema", schema: orgDuplicatesQuerySchema as ParseableSchema, sizeKey: "limit", defaultSize: 20 },
];

describe("migrated schemas — clamp at their ceiling and preserve their own defaults", () => {
  for (const { name, schema, sizeKey, defaultSize, ceiling } of schemaCases) {
    const cap = ceiling ?? PAGE_SIZE_CAP;
    describe(name, () => {
      it(`clamps an over-large page size to exactly ${cap}`, () => {
        const result = schema.parse({ [sizeKey]: 999 });
        expect(result[sizeKey]).toBe(cap);
      });

      it("clamps rather than rejecting, so an over-large page never 400s", () => {
        expect(() => schema.parse({ [sizeKey]: 999 })).not.toThrow();
      });

      it(`defaults page size to ${defaultSize} when absent`, () => {
        const result = schema.parse({});
        expect(result[sizeKey]).toBe(defaultSize);
      });

      // Several of these schemas are mid-migration from offset to cursor, in both
      // directions, so the style is read from the schema rather than declared here.
      // What must hold either way: an offset schema starts at page 1, a cursor
      // schema accepts a cursor, and neither may be missing its size field.
      it("pages consistently with whichever style it exposes", () => {
        const result = schema.parse({});
        expect(result).toHaveProperty(sizeKey);

        const exposesOffset = Object.prototype.hasOwnProperty.call(result, "page");
        if (exposesOffset) expect(result["page"]).toBe(1);

        const exposesCursor = "cursor" in (schema.parse({ cursor: "1" }) as object);
        const exposesIdCursor = "afterId" in (schema.parse({ afterId: 1 }) as object);
        expect(exposesOffset || exposesCursor || exposesIdCursor).toBe(true);
      });
    });
  }

});

interface SizeOnlyCaseConfig {
  name: string;
  schema: ParseableSchema;
  defaultSize: number;
  /** Only where the endpoint keeps a ceiling tighter than the platform cap. */
  ceiling?: number;
  /** Other required fields, so the size field is what the case is testing. */
  base?: Record<string, unknown>;
}

// Cursor and size-only lists: no `page` field, but the same clamp-don't-reject rule on page size.
const sizeOnlyCases: SizeOnlyCaseConfig[] = [
  { name: "searchTicketsQuerySchema", schema: searchTicketsQuerySchema as ParseableSchema, defaultSize: 10, ceiling: 20, base: { q: "bug" } },
  { name: "intakeListQuerySchema", schema: intakeListQuerySchema as ParseableSchema, defaultSize: 50 },
  { name: "territoryListSchema", schema: territoryListSchema as ParseableSchema, defaultSize: 50 },
  { name: "chat listMessagesQuerySchema", schema: chatListMessagesQuerySchema as ParseableSchema, defaultSize: 50 },
  { name: "chat searchQuerySchema", schema: chatSearchQuerySchema as ParseableSchema, defaultSize: 20 },
  { name: "mail listMessagesQuerySchema", schema: mailListMessagesQuerySchema as ParseableSchema, defaultSize: 25, ceiling: 50 },
  { name: "global searchQuerySchema", schema: globalSearchQuerySchema as ParseableSchema, defaultSize: 5, ceiling: 10, base: { q: "acme" } },
];

describe("size-only schemas — clamp at their ceiling and preserve their own defaults", () => {
  for (const { name, schema, defaultSize, ceiling, base } of sizeOnlyCases) {
    const cap = ceiling ?? PAGE_SIZE_CAP;
    const required = base ?? {};
    describe(name, () => {
      it(`clamps an over-large page size to exactly ${cap}`, () => {
        expect(schema.parse({ ...required, limit: 999 })["limit"]).toBe(cap);
      });

      it("clamps rather than rejecting, so an over-large page never 400s", () => {
        expect(() => schema.parse({ ...required, limit: 999 })).not.toThrow();
      });

      it(`defaults page size to ${defaultSize} when absent`, () => {
        expect(schema.parse({ ...required })["limit"]).toBe(defaultSize);
      });

      it("honours a size below the ceiling", () => {
        expect(schema.parse({ ...required, limit: 3 })["limit"]).toBe(3);
      });

      it("still refuses a zero page size", () => {
        expect(() => schema.parse({ ...required, limit: 0 })).toThrow();
      });
    });
  }
});

describe("intakeListQuerySchema paginates by cursor, not offset", () => {
  it("exposes no offset field, so a caller cannot deep-page the intake queue", () => {
    expect("offset" in intakeListQuerySchema.parse({})).toBe(false);
  });

  it("omits the cursor entirely on the first page rather than sending an empty one", () => {
    expect(intakeListQuerySchema.parse({}).cursor).toBeUndefined();
  });

  it("carries an explicit cursor through untouched", () => {
    expect(intakeListQuerySchema.parse({ cursor: "eyJpZCI6NDB9" }).cursor).toBe("eyJpZCI6NDB9");
  });

  it("clamps limit to the shared page cap", () => {
    expect(intakeListQuerySchema.parse({ limit: 5000 }).limit).toBe(100);
  });
});
