import type { AuthResult } from "../../../access/access.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { McpContext } from "./crm-mcp-tool-catalogue";

/**
 * The allow `authorize` returned, as the read a service is handed.
 *
 * This surface's resolver, in the sense ADR 0005 gives the word: the DataScope
 * `authorize` resolved — already clamped to an agent or personal token's own
 * ceiling — is turned into a `ScopedRead` here and nowhere else, so a tool
 * handler receives a read it can spend and never the string behind it.
 *
 * `decision.allow` is the caller's business, not this function's:
 * `CrmMcpService.executeTool` refuses a denied decision with a 402 or a 403
 * before it gets here, and a `none` scope reaching a `ScopedRead` would deny at
 * the query rather than widen — which is the safe direction for the one path
 * that ever slipped past.
 */
export function mcpToolScopedRead(context: McpContext, decision: AuthResult): ScopedRead {
  return ScopedRead.of(context.orgId, context.userId, decision.scope);
}
