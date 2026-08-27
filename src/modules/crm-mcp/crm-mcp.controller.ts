import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../common/auth/public.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AgentTokenGuard } from "../agent-access/agent-token.guard";
import { CrmMcpService, type McpCallOutcome } from "./crm-mcp.service";
import { mcpRequestSchema, mcpToolCallParamsSchema, type McpRequest } from "./dto/crm-mcp.schemas";

/**
 * The protocol surface. A doorway, and deliberately nothing else.
 *
 * Phase 6, ticket 19. Everything here is envelope handling: unwrap JSON-RPC,
 * name a capability, hand it to `CrmMcpService`, wrap what comes back. No
 * decision is taken in this file, which is why the fourth criterion survives
 * contact with the next person to add a method — there is no local state to
 * consult and no service to reach past.
 *
 * `@Public()` with `AgentTokenGuard` is the pattern `agent.controller.ts`
 * already uses: public to the JWT guard, and completely closed to anything
 * without a live agent token. The same class rather than a second guard, so
 * hashing, expiry, revocation, account status and membership are decided in one
 * place for both surfaces.
 *
 * ## What this is not
 *
 * It is HTTP, not a real MCP transport. A client speaks JSON-RPC 2.0 over a
 * single POST and gets one response; there is no SSE stream, no session
 * resumption and no server-initiated notification, so `tools/list_changed`
 * cannot be pushed and a client must poll. That is the honest state of it — an
 * MCP-shaped surface over the existing services rather than a conforming
 * transport — and closing the gap is transport work, not capability work.
 */

/** What a client is told this server speaks. */
const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** Server-defined range, per JSON-RPC. Refusals are errors, never empty results. */
const REFUSED = -32_001;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;

@Public()
@Controller("crm/mcp")
@UseGuards(AgentTokenGuard)
export class CrmMcpController {
  constructor(private readonly mcp: CrmMcpService) {}

  @Post()
  async rpc(
    @Body(new ZodValidationPipe(mcpRequestSchema)) request: McpRequest,
    @CurrentUser() user: CurrentUserContext,
    @Req() req: Request,
  ): Promise<JsonRpcSuccess | JsonRpcFailure> {
    const id = request.id ?? null;

    /*
      Enablement is checked before the method is even looked at, and the answer
      is the same for every method.

      A tenant who has not opened this surface must not be able to learn
      anything through it — not the protocol version, not which methods exist,
      not whether a capability name is real. Answering `initialize` politely and
      refusing everything after it would still confirm that the endpoint is
      there and that the token is good.
    */
    if (!(await this.mcp.isEnabled(user.orgId)))
      return fail(id, REFUSED, "The MCP server is not enabled for this organisation.", {
        refusal: "server-disabled",
      });

    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "streamlineos-crm", version: "1" },
          },
        };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: await this.mcp.listTools(user) } };

      case "tools/call": {
        const params = mcpToolCallParamsSchema.safeParse(request.params ?? {});
        if (!params.success)
          return fail(id, INVALID_PARAMS, "tools/call needs a tool name and arguments.");

        const outcome = await this.mcp.call(user, params.data.name, params.data.arguments, {
          ipAddress: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
        });

        return outcome.ok
          ? { jsonrpc: "2.0", id, result: { content: outcome.result, isError: false } }
          : fail(id, codeFor(outcome), outcome.message, { refusal: outcome.reason });
      }

      default:
        return fail(id, METHOD_NOT_FOUND, `This server does not implement ${request.method}.`);
    }
  }
}

/**
 * A refusal is a JSON-RPC error, not a tool result.
 *
 * MCP lets a tool report its own failure inside a successful result so a model
 * can read it and adapt. That is right for "the deal does not exist" and wrong
 * for "you are not allowed to do that": a refusal returned as content is
 * material an agent will try to reason its way around, and the one thing this
 * ticket is emphatic about is that an agent has no move available against the
 * authorization decision. An error frame gives it nothing to work with.
 */
function fail(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function codeFor(outcome: Extract<McpCallOutcome, { ok: false }>): number {
  if (outcome.reason === "unknown-capability") return METHOD_NOT_FOUND;
  if (outcome.reason === "invalid-arguments") return INVALID_PARAMS;
  return REFUSED;
}
