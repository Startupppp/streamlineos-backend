import { SupportAiTriageService } from "./support-ai-triage.service";
import type { Db } from "../../../db/drizzle.module";

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
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const TICKET = {
  id: 1,
  title: "Cannot login",
  description: "Users cannot login",
  status: "OPEN" as const,
  priority: "HIGH" as const,
};

describe("SupportAiTriageService — cross-tenant isolation", () => {
  describe("suggestMacro", () => {
    it("returns null and scopes macro query to caller org (DENY — cross-tenant isolation)", async () => {
      const findManyMock = jest.fn().mockResolvedValue([]);
      const db = {
        query: { supportMacros: { findMany: findManyMock } },
      } as unknown as Db;

      const data = {
        isAvailable: jest.fn().mockResolvedValue(true),
        getTicketOrThrow: jest.fn().mockResolvedValue(TICKET),
        replacePendingSuggestions: jest.fn().mockResolvedValue(undefined),
        insertSuggestion: jest.fn(),
      };
      const aiGateway = {};
      const aiSettings = {};

      const svc = new SupportAiTriageService(
        db,
        data as never,
        aiGateway as never,
        aiSettings as never,
      );

      const result = await svc.suggestMacro(ATTACKER_ORG, "u-attacker", 1, 10);

      expect(result).toBeNull();
      expect(findManyMock).toHaveBeenCalledTimes(1);
      const whereArg = findManyMock.mock.calls[0]?.[0]?.where;
      const vals = sqlValues(whereArg);
      expect(vals).toContain(ATTACKER_ORG);
      expect(vals).not.toContain(OWNER_ORG);
    });

    it("returns a suggestion when owner org has matching macros (CONTROL — same-tenant access works)", async () => {
      const macroRows = [{ id: 1, title: "Standard response", body: "We are looking into this." }];
      const findManyMock = jest.fn().mockResolvedValue(macroRows);
      const db = {
        query: { supportMacros: { findMany: findManyMock } },
      } as unknown as Db;

      const suggestion = { id: 5, type: "macro", status: "pending", payload: { macroId: 1, reason: "fits" }, confidence: null, createdAt: new Date() };

      const data = {
        isAvailable: jest.fn().mockResolvedValue(true),
        getTicketOrThrow: jest.fn().mockResolvedValue(TICKET),
        replacePendingSuggestions: jest.fn().mockResolvedValue(undefined),
        insertSuggestion: jest.fn().mockResolvedValue(suggestion),
      };
      const aiGateway = {
        invokeStructured: jest.fn().mockResolvedValue({
          ok: true,
          data: { macroId: 1, reason: "Good match", confidence: 0.9 },
        }),
      };
      const aiSettings = {};

      const svc = new SupportAiTriageService(
        db,
        data as never,
        aiGateway as never,
        aiSettings as never,
      );

      const result = await svc.suggestMacro(OWNER_ORG, "u-owner", 1, 10);

      expect(result).not.toBeNull();
      expect(findManyMock.mock.calls[0]?.[0]?.where).toBeDefined();
      const whereVals = sqlValues(findManyMock.mock.calls[0]?.[0]?.where);
      expect(whereVals).toContain(OWNER_ORG);
    });
  });
});
