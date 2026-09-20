const wrapped: string[] = [];

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T,>(_db: unknown, fn: () => Promise<T>) => fn(),
  runInNewTenantTransaction: <T,>(_db: unknown, orgId: string, fn: () => Promise<T>) => {
    wrapped.push(orgId);
    return fn();
  },
}));

import { z } from "zod";
import { buildAskOsToolset } from "./ask-os-tool-registry";
import { data, defineTool } from "./ask-os-tool.types";
import type { AskOsToolDefinition } from "./ask-os-tool.types";
import type { AccessSnapshot } from "../../../access/access.types";
import type { AskOsActor } from "../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";

const ACTOR = { orgId: "org-1", userId: "user-1", membershipId: 1 };
const SNAPSHOT = { scopes: { "hr:policies:view": "all" }, modules: { hr: true } };

function toolsetFor(definition: AskOsToolDefinition): Record<string, unknown> {
  return buildAskOsToolset({
    db: {} as Db,
    actor: ACTOR as unknown as AskOsActor,
    caller: {} as CurrentUserContext,
    snapshot: SNAPSHOT as unknown as AccessSnapshot,
    definitions: [definition],
  });
}

async function invoke(definition: AskOsToolDefinition): Promise<void> {
  const entry = toolsetFor(definition)[definition.key];
  if (entry === undefined) throw new Error(`tool ${definition.key} was filtered out of the toolset`);
  const { execute } = entry as { execute: (input: unknown) => Promise<unknown> };
  await execute({});
}

function probe(ownsTransaction?: true): AskOsToolDefinition {
  const base = {
    key: "probe",
    description: "probe",
    input: z.object({}),
    permission: "hr:policies:view",
    module: "hr",
    run: async () => data({ ok: true }),
  };
  return ownsTransaction === undefined
    ? defineTool(base)
    : defineTool({ ...base, ownsTransaction });
}

describe("a tool that makes a provider call opens its own transaction instead of borrowing the turn's", () => {
  beforeEach(() => {
    wrapped.length = 0;
  });

  it("wraps an ordinary tool, because its reads need the tenant GUC and would raise 42501 without it", async () => {
    await invoke(probe());

    expect(wrapped).toEqual(["org-1"]);
  });

  it("does not wrap a tool declaring ownsTransaction, so a provider round trip cannot hold a pooled connection idle-in-transaction", async () => {
    await invoke(probe(true));

    expect(wrapped).toEqual([]);
  });
});
