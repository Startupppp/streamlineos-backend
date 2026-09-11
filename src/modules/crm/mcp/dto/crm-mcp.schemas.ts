import { z } from "zod";

/**
 * The body of `POST /crm/mcp/call`: which tool, and its arguments.
 *
 * Only the envelope is checked here. Each tool's arguments are its own
 * contract (`inputSchema` in the catalogue), and `executeTool` resolves the
 * tool before anything reads them, so an unknown name is refused and audited
 * there rather than here. `arguments` defaults to `{}` because a tool that
 * takes none is still a call.
 */
export const mcpToolCallSchema = z.object({
  name: z.string().trim().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
