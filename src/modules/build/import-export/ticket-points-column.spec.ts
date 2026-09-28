import { Column } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { Db } from "../../../db/drizzle.types";
import type { AccessService } from "../../access/access.service";
import { queryTickets } from "../core";
import { parseCsvRows } from "./csv-source";
import { parseImportSource } from "./import-source";
import { insertTicketBatch, type ImportActor } from "./ticket-import-batches";
import { buildTicketImportPreview } from "./ticket-import-preview";
import { TicketExportService } from "./ticket-export.service";

const ORG = "org-points";
const PROJECT = 42;

const owner: CurrentUserContext = {
  orgId: ORG,
  userId: "user-owner",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

const actor: ImportActor = { orgId: ORG, userId: "user-owner", membershipId: 1 };

type Values = Record<string, unknown>;

function columnName(field: unknown): string {
  if (!(field instanceof Column)) throw new Error("projection field is not a database column");
  return field.name;
}

function resolveRow(projection: Values, tableRow: Values): Values {
  const row: Values = {};
  for (const [key, field] of Object.entries(projection)) {
    if (!(field instanceof Column))
      throw new Error(`export projection field ${key} is not a database column`);
    row[key] = tableRow[field.name] ?? null;
  }
  return row;
}

function makeExportDb(tableRow: Values) {
  let projection: Values = {};
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([resolveRow(projection, tableRow)]),
  });
  const db = {
    query: { projects: { findFirst: async () => ({ managerMembershipId: null }) } },
    select: (selection: Values) => {
      projection = selection;
      return chain;
    },
  } as unknown as Db;
  return { db, projectionOf: () => projection };
}

function unrestrictedAccess(): AccessService {
  return {
    scopeFor: async () => "all",
    holds: async () => true,
    resolveUserPermissions: async () => new Map<string, string>(),
  } as unknown as AccessService;
}

function makeTx() {
  const batches: Values[][] = [];
  const tx = {
    insert: () => ({
      values: (values: Values[]) => {
        batches.push(values);
        return { returning: async () => values.map((_, index) => ({ id: 100 + index })) };
      },
    }),
  } as unknown as DbOrTx;
  return { tx, batches };
}

async function importCsv(content: string): Promise<Values[]> {
  const parsed = parseImportSource("csv", content);
  expect(parsed.fileError).toBeNull();
  expect(parsed.rowErrors).toEqual([]);
  const preview = buildTicketImportPreview({
    orgId: ORG,
    projectId: PROJECT,
    parsed,
    allowedStatuses: ["TODO"],
    existingTitleKeys: [],
  });
  expect(preview.issues).toEqual([]);
  expect(preview.rows).toHaveLength(1);
  const { tx, batches } = makeTx();
  await insertTicketBatch(tx, actor, PROJECT, 1, preview.rows);
  return batches[0] ?? [];
}

describe("Ticket import and export use the points column", () => {
  it("writes the storyPoints wire field onto the points column and no longer writes story_points, because an imported value landing in story_points was invisible to the ticket UI and every report", async () => {
    const [inserted] = await importCsv("title,status,storyPoints\nImported ticket,TODO,8\n");

    expect(inserted?.["points"]).toBe(8);
    expect(inserted).not.toHaveProperty("storyPoints");
  });

  it("prefers an explicit points cell over storyPoints when a file carries both, because the export emits both names for the one column", async () => {
    const [inserted] = await importCsv("title,status,points,storyPoints\nImported ticket,TODO,3,8\n");

    expect(inserted?.["points"]).toBe(3);
  });

  it("leaves points null when a file carries neither cell, so the non-zero assertions above cannot pass on a default", async () => {
    const [inserted] = await importCsv("title,status\nImported ticket,TODO\n");

    expect(inserted?.["points"]).toBeNull();
  });

  it("exports the points column into the storyPoints wire cell, because reading story_points exported an empty cell for every ticket the UI created", async () => {
    const { db, projectionOf } = makeExportDb({
      ticket_number: 5,
      title: "Ship it",
      type: "TASK",
      status: "TODO",
      priority: "HIGH",
      points: 8,
      story_points: null,
      completion_percentage: 0,
      client_visible: false,
    });
    const service = new TicketExportService(db, unrestrictedAccess());

    const result = await service.exportTickets(owner, PROJECT, { format: "csv" });

    const projection = projectionOf();
    expect(columnName(projection["storyPoints"])).toBe("points");
    expect(columnName(projection["points"])).toBe("points");
    const [header, row] = parseCsvRows(result.content);
    expect(row?.[(header ?? []).indexOf("points")]).toBe("8");
    expect(row?.[(header ?? []).indexOf("storyPoints")]).toBe("8");
  });

  it("round-trips a UI-created point value through export and import back onto the points column, because the export read one column and the import wrote the other", async () => {
    const { db } = makeExportDb({
      ticket_number: 5,
      title: "Ship it",
      type: "TASK",
      status: "TODO",
      priority: "HIGH",
      points: 8,
      story_points: null,
      completion_percentage: 0,
      client_visible: false,
    });
    const exported = await new TicketExportService(db, unrestrictedAccess()).exportTickets(
      owner,
      PROJECT,
      { format: "csv" },
    );

    const [header, row] = parseCsvRows(exported.content);
    expect(row?.[(header ?? []).indexOf("storyPoints")]).toBe("8");

    const [reimported] = await importCsv(exported.content);

    expect(reimported?.["points"]).toBe(8);
    expect(reimported).not.toHaveProperty("storyPoints");
    expect(reimported?.["title"]).toBe("Ship it");
  });

  it("writes the column the ticket list projection reads, because story_points was selected by no surface the UI renders", async () => {
    let captured: { columns?: Record<string, unknown> } = {};
    const db = {
      query: {
        tickets: {
          findMany: async (args: { columns?: Record<string, unknown> }) => {
            captured = args;
            return [];
          },
        },
      },
    } as unknown as Db;

    await queryTickets(db, undefined, [], 10);
    const [inserted] = await importCsv("title,status,storyPoints\nImported ticket,TODO,8\n");

    expect(captured.columns?.["points"]).toBe(true);
    expect(Object.keys(inserted ?? {})).toContain("points");
    expect(inserted?.["points"]).toBe(8);
  });
});
