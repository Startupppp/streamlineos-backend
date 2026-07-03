import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../common/auth/public.decorator";
import { KbPagesService } from "./kb-pages.service";

const tokenParamSchema = z.string().max(64).regex(/^[a-zA-Z0-9-]+$/);

@Public()
@Controller("public/wiki")
export class KbPublicPagesController {
  constructor(private readonly pages: KbPagesService) {}

  @Get(":token")
  async getPublicPage(@Param("token") token: string): Promise<unknown> {
    const parsed = tokenParamSchema.safeParse(token);
    if (!parsed.success) throw new NotFoundException("Page not found");
    return this.pages.getPublicPage(parsed.data);
  }
}