import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../common/auth/universal.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ManagerHomeService } from "./manager-home.service";
import { managerHomeResponseSchema } from "./dto/manager-home-response.schemas";

@Controller("me/team")
@UseGuards(JwtAuthGuard)
export class ManagerHomeController {
  constructor(private readonly managerHome: ManagerHomeService) {}

  @Get()
  @Universal()
  @ResponseSchema(managerHomeResponseSchema)
  get(@CurrentUser() u: CurrentUserContext) {
    return this.managerHome.getHome(u);
  }
}
