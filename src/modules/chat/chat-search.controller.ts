import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ChatSearchService } from "./chat-search.service";
import { actorOf } from "../entity-reference/entity-actor";
import { Validate } from "../../common/validation/validate.decorator";
import {
  searchMessagesQuerySchema,
  searchQuerySchema,
  type SearchMessagesQueryInput,
  type SearchQueryInput,
} from "./dto/chat-search.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  chatSearchChannelsResponseSchema,
  chatSearchMessagesResponseSchema,
  chatSearchUsersResponseSchema,
} from "./dto/chat-misc-response.schemas";

@ApiTags("Chat Search")
@ApiBearerAuth()
@Controller("chat/search")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatSearchController {
  constructor(private readonly search: ChatSearchService) {}

  @ApiOperation({ summary: "Search messages by keyword with optional date range and sender filters" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("messages")
  @ResponseSchema(chatSearchMessagesResponseSchema)
  @RequirePermission("chat:messages:read")
  @Validate({ query: searchMessagesQuerySchema })
  searchMessages(
    @Query() query: SearchMessagesQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.search.searchMessages(
      actorOf(u),
      query.q,
      query.limit,
      query.cursor,
      query.from,
      query.to,
      query.sender,
    );
  }

  @ApiOperation({ summary: "Search channels by name" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("channels")
  @ResponseSchema(chatSearchChannelsResponseSchema)
  @RequirePermission("chat:channels:read")
  @Validate({ query: searchQuerySchema })
  searchChannels(@Query() query: SearchQueryInput, @CurrentUser() u: CurrentUserContext) {
    return this.search.searchChannels(actorOf(u), query.q);
  }

  @ApiOperation({ summary: "Search users in the organisation by name or email" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("users")
  @ResponseSchema(chatSearchUsersResponseSchema)
  @RequirePermission("chat:channels:read")
  @Validate({ query: searchQuerySchema })
  searchUsers(@Query() query: SearchQueryInput, @CurrentUser() u: CurrentUserContext) {
    return this.search.searchUsers(u.orgId, query.q);
  }
}
