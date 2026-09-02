import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { SupportAiTriageDataService } from "./support-ai-triage-data.service";

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

function makeDataSvc(
  accessibleSpaceIds: number[],
  selectResult: unknown[],
): { svc: SupportAiTriageDataService; selectWhere: jest.Mock } {
  const selectWhere = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(selectResult) }),
  });

  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: selectWhere,
          }),
        }),
      }),
    }),
  };

  const embeddings = {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    embedQueryWithCredit: jest.fn().mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: "[0.1,0.2]" }),
  };

  const orgFeatures = {
    getFlags: jest.fn().mockResolvedValue({ supportAi: true }),
  };

  const kbAccess = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue(accessibleSpaceIds),
    getPrincipalIds: jest.fn().mockResolvedValue({ userId: "u1", roleSlugs: [] }),
  };

  const svc = new SupportAiTriageDataService(
    db as never,
    embeddings as never,
    orgFeatures as never,
    kbAccess as never,
  );

  return { svc, selectWhere };
}

describe("SupportAiTriageDataService.searchKbForTicket — KB space ACL in RAG search (cross-tenant isolation)", () => {
  const OWNER_ORG = "org-owner";
  const OWNER_USER = "user-owner-1";

  const ownerCtx: CurrentUserContext = {
    orgId: OWNER_ORG,
    userId: OWNER_USER,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  };

  it("returns empty array when caller has no accessible KB spaces (cross-tenant deny — private space)", async () => {
    const { svc, selectWhere } = makeDataSvc([], []);

    const result = await svc.searchKbForTicket(ownerCtx, "Login broken");

    expect(result).toEqual([]);
    expect(selectWhere).not.toHaveBeenCalled();
  });

  it("includes accessible space IDs in the SQL predicate (control — same-tenant access works)", async () => {
    const spaceIds = [10, 20];
    const { svc, selectWhere } = makeDataSvc(spaceIds, []);

    await svc.searchKbForTicket(ownerCtx, "Login broken");

    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0];
    const vals = sqlValues(whereArg);
    expect(vals).toContain(10);
    expect(vals).toContain(20);
    expect(vals).toContain(OWNER_ORG);
  });
});
