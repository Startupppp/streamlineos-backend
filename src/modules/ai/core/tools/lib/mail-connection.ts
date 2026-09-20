import { type Db } from "../../../../../db/drizzle.module";
import { type IntegrationToolkit } from "../../../../../db/schema";
import { resolveToolkitConnection } from "../../../../integrations/core/connection-resolution";

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
