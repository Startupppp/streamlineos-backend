jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T,>(_db: unknown, fn: () => Promise<T>) => fn(),
  runInNewTenantTransaction: <T,>(_db: unknown, _orgId: string, fn: () => Promise<T>) => fn(),
}));

import { z } from "zod";
import { buildAskOsToolset } from "./ask-os-tool-registry";
import { defineTool, needsConfirmation, needsConnection } from "./ask-os-tool.types";
import type { AskOsDirective } from "../streaming/ask-os-directive";
import type { AskOsToolDefinition } from "./ask-os-tool.types";
import type { AccessSnapshot } from "../../../access/access.types";
import type { AskOsActor } from "../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";

const ACTOR = { orgId: "org-1", userId: "user-1", membershipId: 1 };
const SNAPSHOT = { scopes: {}, modules: {} };
const SECRET_TOKEN = "3.deadbeef.signature";

const confirming = defineTool({
  key: "sendSomething",
  description: "d",
  input: z.object({}),
  run: async () =>
    needsConfirmation({
      proposalId: 3,
      token: SECRET_TOKEN,
      action: "mail.send",
      summary: "Send an email to a@b.c",
      preview: { to: "a@b.c" },
    }),
});

const connecting = defineTool({
  key: "needsGmail",
  description: "d",
  input: z.object({}),
  run: async () => needsConnection("gmail", "no-connection", "Connect Gmail"),
});

async function runTool(
  definition: AskOsToolDefinition,
  onDirective?: (directive: AskOsDirective) => void,
): Promise<unknown> {
  const toolset = buildAskOsToolset({
    db: {} as Db,
    actor: ACTOR as unknown as AskOsActor,
    caller: {} as CurrentUserContext,
    snapshot: SNAPSHOT as unknown as AccessSnapshot,
    definitions: [definition],
    ...(onDirective === undefined ? {} : { onDirective }),
  });
  const entry = toolset[definition.key];
  if (entry === undefined) throw new Error(`tool ${definition.key} was filtered out`);
  const { execute } = entry as { execute: (input: unknown) => Promise<unknown> };
  return execute({});
}

describe("a confirmation token is withheld from the model whether or not a directive sink exists", () => {
  it("returns the pending-confirmation status and no token when a sink is supplied", async () => {
    const seen: AskOsDirective[] = [];
    const result = await runTool(confirming, (d) => seen.push(d));

    expect(result).toEqual({
      status: "pending_confirmation",
      summary: "Send an email to a@b.c",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "confirm-action",
      proposalId: 3,
      token: SECRET_TOKEN,
      action: "mail.send",
    });
  });

  it("still withholds the token when no sink is supplied, because the decision to withhold must not depend on the caller wiring one up", async () => {
    const result = await runTool(confirming);

    expect(result).toEqual({
      status: "pending_confirmation",
      summary: "Send an email to a@b.c",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("proposalId");
  });

  it("collapses a connection gap to its status without a sink too, so the toolkit handshake cannot leak as a raw outcome", async () => {
    const result = await runTool(connecting);

    expect(result).toEqual({ status: "connection_required", summary: "Connect Gmail" });
  });
});
