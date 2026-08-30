import type { Db } from "../../../db/drizzle.module";
import { SupportAiService } from "./support-ai.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value as object)) return [];
  seen.add(value as object);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeSvc(
  accessibleSpaceIds: number[],
  selectResult: unknown[],
): { svc: SupportAiService; selectWhere: jest.Mock } {
  const ticket = { id: 1, orgId: "org-owner", title: "Login broken", description: null };

  const selectWhere = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(selectResult) }),
  });

  const db = {
    query: {
      supportTickets: { findFirst: jest.fn().mockResolvedValue(ticket) },
      supportAiSuggestions: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: selectWhere,
          }),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 99 }]) }) }),
  } as unknown as Db;

  const embeddings = {
    isConfigured: jest.fn().mockReturnValue(true),
    embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]),
    toVectorLiteral: jest.fn().mockReturnValue("[0.1,0.2]"),
  };

  const orgFeatures = {
    getFlags: jest.fn().mockResolvedValue({ supportAi: true }),
  };

  const kbAccess = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue(accessibleSpaceIds),
    getPrincipalIds: jest.fn().mockResolvedValue({ userId: "u1", roleSlugs: [] }),
  };

  const svc = new SupportAiService(
    db,
    null as never,
    embeddings as never,
    orgFeatures as never,
    null as never,
    null as never,
    null as never,
    kbAccess as never,
  );

  return { svc, selectWhere };
}

describe("SupportAiService — KB space ACL in RAG search (cross-tenant isolation)", () => {
  const OWNER_ORG = "org-owner";
  const OWNER_USER = "user-owner-1";
  const TICKET_ID = 1;

  it("returns null when caller has no accessible KB spaces (cross-tenant deny — private space)", async () => {
    const { svc, selectWhere } = makeSvc([], []);

    const result = await (svc as unknown as { suggestKbArticles: (orgId: string, ticketId: number, userId: string) => Promise<unknown> })
      .suggestKbArticles(OWNER_ORG, TICKET_ID, OWNER_USER);

    expect(result).toBeNull();
    expect(selectWhere).not.toHaveBeenCalled();
  });

  it("includes accessible space IDs in the SQL predicate (control — same-tenant access works)", async () => {
    const spaceIds = [10, 20];
    const { svc, selectWhere } = makeSvc(spaceIds, []);

    await (svc as unknown as { suggestKbArticles: (orgId: string, ticketId: number, userId: string) => Promise<unknown> })
      .suggestKbArticles(OWNER_ORG, TICKET_ID, OWNER_USER);

    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0];
    const vals = sqlValues(whereArg);
    expect(vals).toContain(10);
    expect(vals).toContain(20);
    expect(vals).toContain(OWNER_ORG);
  });
});
