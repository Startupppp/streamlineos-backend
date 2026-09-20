import "reflect-metadata";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildAskOsToolset } from "../registry/ask-os-tool-registry";
import { defineTool, data, type AskOsToolDefinition, type AskOsToolProvider } from "../registry/ask-os-tool.types";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AccessSnapshot } from "../../../access/access.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { Db } from "../../../../db/drizzle.module";

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (_db: unknown, orgId: string, body: () => Promise<unknown>) => {
      tenantScopes.push(orgId);
      return body();
    },
  ),
}));

const tenantScopes: string[] = [];

type ProviderClass = new (...args: never[]) => AskOsToolProvider;

const TOOLS_DIR = __dirname;

const SUBJECT_KEYS = new Set([
  "userId",
  "orgId",
  "actorId",
  "createdById",
  "authorId",
  "subjectId",
  "memberId",
  "personId",
  "employeeId",
  "targetUserId",
  "membershipId",
  "organizationId",
]);

function isExecutableTool(
  value: unknown,
): value is { execute: (input: unknown) => Promise<unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

function isProviderClass(candidate: unknown): candidate is ProviderClass {
  return (
    typeof candidate === "function" &&
    typeof (candidate as { prototype?: { tools?: unknown } }).prototype?.tools === "function"
  );
}

function selfToolFiles(): string[] {
  return fs
    .readdirSync(TOOLS_DIR)
    .filter((name) => name.startsWith("self-") && name.endsWith("-tools.ts") && !name.includes(".spec."));
}

function selfToolDefinitions(): { file: string; definition: AskOsToolDefinition }[] {
  return selfToolFiles().flatMap((file) => {
    const loaded: unknown = require(path.join(TOOLS_DIR, file));
    if (loaded === null || typeof loaded !== "object") return [];
    return Object.values(loaded)
      .filter(isProviderClass)
      .flatMap((klass) => {
        const stub = Object.create(klass.prototype) as AskOsToolProvider;
        return stub.tools().map((definition) => ({ file, definition }));
      });
  });
}

function subjectKeysIn(schema: z.ZodType, seen = new Set<z.ZodType>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);

  const definition: unknown = (schema as { _def?: unknown })._def;
  if (definition === null || typeof definition !== "object") return [];
  const found: string[] = [];

  const shape = (schema as { shape?: unknown }).shape;
  if (shape !== undefined && shape !== null && typeof shape === "object") {
    for (const [key, value] of Object.entries(shape)) {
      if (SUBJECT_KEYS.has(key)) found.push(key);
      if (value instanceof z.ZodType) found.push(...subjectKeysIn(value, seen));
    }
  }

  for (const key of ["innerType", "element", "type", "valueType", "schema"]) {
    const nested = (definition as Record<string, unknown>)[key];
    if (nested instanceof z.ZodType) found.push(...subjectKeysIn(nested, seen));
  }

  return found;
}

const SELF_DEFINITIONS = selfToolDefinitions();

describe("a self-service tool that accepts a subject identifier lets the model read another person's record", () => {
  it("discovers every self-*-tools.ts file, because a hand-listed set stops covering the next one", () => {
    const covered = new Set(SELF_DEFINITIONS.map((entry) => entry.file));
    expect(selfToolFiles().filter((file) => !covered.has(file))).toEqual([]);
  });

  it("collects enough definitions that the assertion below cannot pass vacuously", () => {
    expect(SELF_DEFINITIONS.length).toBeGreaterThan(15);
  });

  it("declares no subject identifier in any self tool's input schema, at any nesting depth", () => {
    const offenders = SELF_DEFINITIONS.flatMap(({ file, definition }) =>
      subjectKeysIn(definition.input).map((key) => `${file}:${definition.key}.${key}`),
    );

    expect(offenders).toEqual([]);
  });

  it("catches a planted subject identifier, so the walker is not merely returning an empty list", () => {
    const planted = defineTool({
      key: "testPlantedSubject",
      description: "d",
      input: z.object({ note: z.string(), nested: z.object({ userId: z.string() }) }),
      run: async () => data({}),
    });

    expect(subjectKeysIn(planted.input)).toEqual(["userId"]);
  });
});

describe("the tenant a self tool runs under comes from the session actor, never from what the model passed", () => {
  const SNAPSHOT: AccessSnapshot = {
    modules: {},
    scopes: {},
  } as unknown as AccessSnapshot;

  function actorFor(orgId: string, userId: string): AskOsActor {
    return {
      userId,
      orgId,
      membershipId: 1,
      displayName: "A",
      email: "a@example.com",
      orgName: "Org",
      role: "MEMBER",
      isOrgOwner: false,
      timezone: "UTC",
      today: "2026-09-20",
      monthStart: "2026-09-01",
      monthEnd: "2026-09-30",
      currentYear: 2026,
      currentMonth: 9,
    };
  }

  function callerFor(orgId: string, userId: string): CurrentUserContext {
    return {
      userId,
      orgId,
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "sess",
      tokenScopes: null,
      principal: humanSessionPrincipal(1, false),
    };
  }

  const probe = defineTool({
    key: "probeSubject",
    description: "d",
    input: z.object({ note: z.string().optional() }),
    run: async (_input, ctx) => data({ orgId: ctx.actor.orgId, userId: ctx.actor.userId }),
  });

  async function runProbeAs(orgId: string, userId: string, rawInput: unknown): Promise<unknown> {
    const toolset = buildAskOsToolset({
      db: {} as unknown as Db,
      actor: actorFor(orgId, userId),
      caller: callerFor(orgId, userId),
      snapshot: SNAPSHOT,
      definitions: [probe],
    });
    const entry: unknown = toolset.probeSubject;
    if (!isExecutableTool(entry))
      throw new Error("buildAskOsToolset did not expose an executable probeSubject tool");
    return entry.execute(rawInput);
  }

  beforeEach(() => {
    tenantScopes.length = 0;
  });

  it("opens each tool's transaction on the actor's own org, so two members of two orgs never share a tenant scope", async () => {
    await runProbeAs("org-a", "user-a", {});
    await runProbeAs("org-b", "user-b", {});

    expect(tenantScopes).toEqual(["org-a", "org-b"]);
  });

  it("ignores an orgId and userId supplied in the tool input, because a model-supplied tenant is an impersonation hole", async () => {
    const result = await runProbeAs("org-a", "user-a", {
      note: "n",
      orgId: "org-victim",
      userId: "user-victim",
    });

    expect(tenantScopes).toEqual(["org-a"]);
    expect(result).toMatchObject({ ok: true, data: { orgId: "org-a", userId: "user-a" } });
  });
});
