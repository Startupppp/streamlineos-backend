import { ConflictException, Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { paragraphize } from "../help-centre/lib/kb-page-content";
import { KbResearchBriefService } from "../retrieval/kb-research-brief.service";
import { KbPagesService } from "./kb-pages.service";
import type { ConvertBriefToPageInput } from "./dto/kb-brief-to-page.schemas";

const BRIEF_TITLE_CAP = 500;

@Injectable()
export class KbBriefToPageService {
  constructor(
    private readonly briefs: KbResearchBriefService,
    private readonly pages: KbPagesService,
  ) {}

  async convert(
    user: CurrentUserContext,
    briefId: number,
    input: ConvertBriefToPageInput,
    canManage: boolean,
  ): Promise<{ pageId: number }> {
    const brief = await this.briefs.getById(user, briefId);
    if (brief.status !== "completed" || !brief.report) {
      throw new ConflictException("Research brief has no completed report to convert");
    }

    const page = await this.pages.create(user, {
      title: brief.topic.slice(0, BRIEF_TITLE_CAP),
      spaceId: input.spaceId ?? brief.spaceId ?? undefined,
      parentPageId: input.parentPageId ?? undefined,
    });

    await this.pages.update(
      user,
      page.id,
      { content: paragraphize(brief.report) },
      canManage,
    );

    return { pageId: page.id };
  }
}
