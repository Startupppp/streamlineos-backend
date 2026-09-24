import { type Db } from "../../../../../db/drizzle.module";
import { type IntegrationToolkit } from "../../../../../db/schema";
import { resolveToolkitConnection } from "../../../../integrations/core/connection-resolution";
import { runInNewTenantTransaction } from "../../../../../common/tenant/run-in-tenant-transaction";
import { needsConnection, type ToolOutcome } from "../../registry/ask-os-tool.types";

export type MailConnectionOutcome =
  | { connected: true }
  | { connected: false; toolkit: IntegrationToolkit; reason: "no-connection" | "needs-reauth" };

export async function resolveAnyMailConnection(
  db: Db,
  subject: { orgId: string; userId: string; membershipId: number },
): Promise<MailConnectionOutcome> {
  const [gmail, outlook] = await Promise.all([
    resolveToolkitConnection(db, { ...subject, toolkit: "gmail" }),
    resolveToolkitConnection(db, { ...subject, toolkit: "outlook" }),
  ]);
  if (gmail.status === "resolved" || outlook.status === "resolved") return { connected: true };
  if (gmail.status === "unresolved" && gmail.reason === "needs-reauth") {
    return { connected: false, toolkit: "gmail", reason: "needs-reauth" };
  }
  if (outlook.status === "unresolved" && outlook.reason === "needs-reauth") {
    return { connected: false, toolkit: "outlook", reason: "needs-reauth" };
  }
  return { connected: false, toolkit: "gmail", reason: "no-connection" };
}

export type MailConnectionGate =
  | { connected: true }
  | { connected: false; outcome: ToolOutcome };

export async function requireMailConnection(
  db: Db,
  subject: { orgId: string; userId: string; membershipId: number },
  summary: string,
): Promise<MailConnectionGate> {
  const resolved = await runInNewTenantTransaction(db, subject.orgId, () =>
    resolveAnyMailConnection(db, subject),
  );
  if (resolved.connected) return { connected: true };
  return {
    connected: false,
    outcome: needsConnection(resolved.toolkit, resolved.reason, summary),
  };
}
