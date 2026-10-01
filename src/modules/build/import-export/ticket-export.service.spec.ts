import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import type { Db } from "../../../db/drizzle.types";
import { parseCsvRows } from "./csv-source";
import { parseImportSource } from "./import-source";
import { TicketExportService, TICKET_EXPORT_COLUMNS } from "./ticket-export.service";
import { projectAccessRow, standingAccess, type ProjectAccessRow } from "../core/project-crud/__tests__/project-access-doubles";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = 42;
const dialect = new PgDialect();

const owner: CurrentUserContext = {
  orgId: ORG,
  userId: "user-owner",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

const ticketRow = {
  ticketNumber: 5,
  title: 'Ship, "it"',
  description: "line one\nline two",
  type: "TASK",
  status: "TODO",
  priority: "HIGH",
  startDate: null,
  dueDate: "2026-10-01",
  points: 3,
  storyPoints: null,
  estimate: null,
  completionPercentage: 0,
  clientVisible: false,
  link: null,
};

interface Capture {
  where: SQL | undefined;
  limit: number | undefined;
  queries: number;
}

function makeDb(rows: unknown[], project: ProjectAccessRow | null = projectAccessRow()) {
  const capture: Capture = { where: undefined, limit: undefined, queries: 0 };
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    where: (condition: SQL) => {
      capture.where = condition;
      return chain;
    },
    orderBy: () => chain,
    limit: (value: number) => {
      capture.limit = value;
      return Promise.resolve(rows);
    },
  });
  const projectChain = {
    from: () => projectChain,
    where: () => projectChain,
    limit: async () => (project === null ? [] : [project]),
  };
  const db = {
    select: jest.fn((fields?: Record<string, unknown>) => {
      if (fields !== undefined && "manages" in fields) return projectChain;
      capture.queries += 1;
      return chain;
    }),
  };
  return { db: db as unknown as Db, capture };
}

function makeAccess(ticketScope: DataScope = "all") {
  return standingAccess({ "build:manage": "all", "build:view": "all", "build:tickets:view": ticketScope }) as unknown as AccessService;
}

describe("TicketExportService", () => {
  it("refuses a project that is not in the caller's organisation", async () => {
    const { db } = makeDb([], null);
    const service = new TicketExportService(db, makeAccess());

    await expect(
      service.exportTickets(owner, PROJECT, { format: "csv" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns nothing and issues no ticket query when the caller's ticket scope is none", async () => {
    const { db, capture } = makeDb([ticketRow]);
    const service = new TicketExportService(db, makeAccess("none"));

    const result = await service.exportTickets(owner, PROJECT, { format: "json" });

    expect(result.rowCount).toBe(0);
    expect(JSON.parse(result.content)).toEqual([]);
    expect(capture.queries).toBe(0);
  });

  it("confines the read to the caller's organisation, project and live rows", async () => {
    const { db, capture } = makeDb([ticketRow]);
    const service = new TicketExportService(db, makeAccess());

    await service.exportTickets(owner, PROJECT, { format: "csv" });

    const query = dialect.sqlToQuery(capture.where as SQL);
    expect(query.sql).toContain("org_id");
    expect(query.sql).toContain("project_id");
    expect(query.sql).toContain("deleted_at");
    expect(query.params).toContain(ORG);
    expect(query.params).toContain(PROJECT);
  });

  it("caps the page at the export bound and honours a smaller request", async () => {
    const { db, capture } = makeDb([]);
    const service = new TicketExportService(db, makeAccess());

    await service.exportTickets(owner, PROJECT, { format: "csv", limit: 10 });
    expect(capture.limit).toBe(10);

    await service.exportTickets(owner, PROJECT, { format: "csv", limit: 999_999 });
    expect(capture.limit).toBe(5000);
  });

  it("writes a CSV whose header is the export column set", async () => {
    const { db } = makeDb([ticketRow]);
    const service = new TicketExportService(db, makeAccess());

    const result = await service.exportTickets(owner, PROJECT, { format: "csv" });

    expect(result.contentType).toBe("text/csv");
    expect(result.filename).toBe("build-project-42-tickets.csv");
    expect(parseCsvRows(result.content)[0]).toEqual([...TICKET_EXPORT_COLUMNS]);
  });

  it("escapes values so a title with a comma survives the round trip", async () => {
    const { db } = makeDb([ticketRow]);
    const service = new TicketExportService(db, makeAccess());

    const result = await service.exportTickets(owner, PROJECT, { format: "csv" });
    const [, row] = parseCsvRows(result.content);

    expect(row?.[1]).toBe('Ship, "it"');
    expect(row?.[2]).toBe("line one\nline two");
  });

  it("produces a CSV an import can read back without unknown field errors", async () => {
    const { db } = makeDb([ticketRow]);
    const service = new TicketExportService(db, makeAccess());

    const result = await service.exportTickets(owner, PROJECT, { format: "csv" });
    const reparsed = parseImportSource("csv", result.content);

    expect(reparsed.fileError).toBeNull();
    expect(reparsed.rowErrors).toEqual([]);
    expect(reparsed.rows[0]?.values).not.toHaveProperty("ticketNumber");
    expect(reparsed.rows[0]?.values.title).toBe('Ship, "it"');
  });

  it("renders null cells as empty rather than the string null", async () => {
    const { db } = makeDb([ticketRow]);
    const service = new TicketExportService(db, makeAccess());

    const result = await service.exportTickets(owner, PROJECT, { format: "csv" });
    const header = parseCsvRows(result.content)[0] as string[];
    const row = parseCsvRows(result.content)[1] as string[];

    expect(row[header.indexOf("startDate")]).toBe("");
    expect(row[header.indexOf("clientVisible")]).toBe("false");
  });

  it("writes JSON as an array of the same records", async () => {
    const { db } = makeDb([ticketRow]);
    const service = new TicketExportService(db, makeAccess());

    const result = await service.exportTickets(owner, PROJECT, { format: "json" });

    expect(result.contentType).toBe("application/json");
    expect(JSON.parse(result.content)).toEqual([ticketRow]);
  });
});
