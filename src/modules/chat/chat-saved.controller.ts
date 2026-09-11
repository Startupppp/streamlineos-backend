import { Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ChatSavedService } from "./chat-saved.service";
import { actorOf } from "../entity-reference/entity-actor";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { chatOkSchema, chatSavedListResponseSchema } from "./dto/chat-misc-response.schemas";
import { pageSizeField } from "../../common/pagination/list-query.schema";

const messageIdParams = z.object({ messageId: z.coerce.number().int().positive() }).strict();

/**
 * `?limit=abc` used to reach the database as `NaN`.
 *
 * The hand-rolled clamp `limit ? Math.min(Math.max(1, parseInt(limit, 10)), 100) : 30` is
 * NaN-transparent — `Math.max(1, NaN)` is `NaN`, `Math.min(NaN, 100)` is `NaN` — and the
 * service's own `Math.min(Math.max(1, limit), 100)` reproduced it, so `findMany({ limit:
 * NaN + 1 })` was issued. Measured against drizzle-orm 0.45.2 and a real Postgres: the
 * dialect emits `limit` only when `typeof limit === "number" && limit >= 0`
 * (pg-core/dialect.js:286) and `NaN >= 0` is false, so the clause is DROPPED — the query
 * does not error, it returns EVERY saved message the member has, with `message`,
 * `senderMembership`, `channel` and `attachments` hydrated for each, and then resolves
 * entity references over all of them. `buildIdCursorPage(rows, NaN)` then compares
 * `rows.length > NaN` (false), so `hasMore` is false and the whole unbounded set is
 * returned as one page with no cursor.
 *
 * `?cursor=abc` was a quieter wrong answer: `parseInt` gave `NaN`, `NaN` is falsy, and the
 * service's `if (cursor)` dropped the keyset predicate — page two silently answered with
 * page one instead of rejecting the cursor.
 *
 * `pageSizeField` clamps rather than 400s on an over-large number (a bookmarked link still
 * gets a page) but REJECTS a non-numeric one, which is the distinction the hand-rolled
 * clamp could not make.
 */
const savedListQuery = z
  .object({
    cursor: z.coerce.number().int().positive().optional(),
    limit: pageSizeField(30, 100),
  })
  .strict();
type SavedListQuery = z.infer<typeof savedListQuery>;

@ApiTags("Chat Saved Messages")
@ApiBearerAuth()
@Controller("chat/saved")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatSavedController {
  constructor(private readonly saved: ChatSavedService) {}

  @ApiOperation({ summary: "List saved messages for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get()
  @ResponseSchema(chatSavedListResponseSchema)
  @RequirePermission("chat:messages:read")
  @Validate({ query: savedListQuery })
  list(@Query() query: SavedListQuery, @CurrentUser() u: CurrentUserContext) {
    return this.saved.list(actorOf(u), query.cursor, query.limit);
  }

  @ApiOperation({ summary: "Save a message to the current user's saved list" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":messageId")
  @ResponseSchema(chatOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  @Validate({ params: messageIdParams })
  save(@Param("messageId", ParseIntPipe) messageId: number, @CurrentUser() u: CurrentUserContext) {
    return this.saved.save(actorOf(u), messageId);
  }

  @ApiOperation({ summary: "Remove a message from the current user's saved list" })
  @ApiResponse({ status: 200, description: "OK" })
  @Delete(":messageId")
  @ResponseSchema(chatOkSchema)
  @RequirePermission("chat:messages:write")
  @Validate({ params: messageIdParams })
  unsave(@Param("messageId", ParseIntPipe) messageId: number, @CurrentUser() u: CurrentUserContext) {
    return this.saved.unsave(actorOf(u), messageId);
  }
}
