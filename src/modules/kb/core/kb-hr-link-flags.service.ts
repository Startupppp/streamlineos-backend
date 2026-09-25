import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { kbSettings } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { EntitlementsService } from "../../access/entitlements.service";
import type { HrKbLinkFlags, HrKbLinkFlagsAdmin, UpdateHrKbLinkFlagsInput } from "./dto/kb-hr-link-flags.schemas";

export const HR_KB_LINK_FLAGS_OFF: HrKbLinkFlags = { link: false, search: false, ai: false };

const HR_MODULE = "hr";

/**
 * The per-tenant switches for HR documents in the knowledge base: `link` (publish and browse), `search`
 * (find them in KB search) and `ai` (let the assistants cite them). Stored on `kb_settings`, default off.
 *
 * The three switches are read UNCACHED, one indexed row, so turning one off is felt on the very next request. The HR
 * module condition alongside them follows the entitlement cache instead (a few seconds per instance), so disabling the
 * HR module itself can take that long to reach every instance. Every route of
 * the feature calls `assertEnabled` first and answers 404 while its switch is off, as if the route did not
 * exist; with all three off nothing about the knowledge base or HR documents changes.
 */
@Injectable()
export class KbHrLinkFlagsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /** What is stored, whether or not HR is enabled. A tenant with no settings row has everything off. */
  async getStored(orgId: string): Promise<HrKbLinkFlags> {
    const row = await this.db.query.kbSettings.findFirst({
      where: eq(kbSettings.orgId, orgId),
      columns: { hrmsKbLinkEnabled: true, hrmsKbSearchEnabled: true, hrmsKbAiEnabled: true },
    });
    if (!row) return HR_KB_LINK_FLAGS_OFF;
    return { link: row.hrmsKbLinkEnabled, search: row.hrmsKbSearchEnabled, ai: row.hrmsKbAiEnabled };
  }

  /**
   * What the routes act on. A stored switch counts only while the HR module is enabled for the tenant (the
   * documents belong to HR: disable HR and the entries go with it), and each switch needs the one before it,
   * even if a row somehow says otherwise.
   */
  async getEffective(orgId: string): Promise<HrKbLinkFlags> {
    const stored = await this.getStored(orgId);
    if (!stored.link) return HR_KB_LINK_FLAGS_OFF;
    if (!(await this.entitlements.isModuleEnabled(orgId, HR_MODULE))) return HR_KB_LINK_FLAGS_OFF;
    return { link: true, search: stored.search, ai: stored.search && stored.ai };
  }

  /**
   * 404, not 403: a disabled feature should look absent, and a 403 would confirm it exists.
   *
   * The code is what makes it usable. A bare NotFoundException fell through to the filter's default
   * `NOT_FOUND`, which is the same envelope a deleted document produces, so a client could not tell "this
   * organisation has not turned the feature on" from "that row is gone" and had nothing to render (V-140).
   * The message names no flag and no organisation, so it still says nothing about what exists.
   */
  async assertEnabled(orgId: string, flag: keyof HrKbLinkFlags): Promise<void> {
    const effective = await this.getEffective(orgId);
    if (!effective[flag])
      throw new NotFoundException({ code: "FEATURE_DISABLED", message: "This feature is not available." });
  }

  async getAdmin(orgId: string): Promise<HrKbLinkFlagsAdmin> {
    const [stored, effective, hrModuleEnabled] = await Promise.all([
      this.getStored(orgId),
      this.getEffective(orgId),
      this.entitlements.isModuleEnabled(orgId, HR_MODULE),
    ]);
    return { stored, effective, hrModuleEnabled };
  }

  /**
   * Turning a switch OFF is always allowed and takes its dependants with it (search off ⇒ ai off; link off ⇒
   * both). Turning one ON needs HR enabled and the switch before it on, in the same request or already.
   * Audited in the request transaction: the change and its record commit together or not at all.
   */
  async update(actor: CurrentUserContext, patch: UpdateHrKbLinkFlagsInput): Promise<HrKbLinkFlagsAdmin> {
    const before = await this.getStored(actor.orgId);
    const requested: HrKbLinkFlags = {
      link: patch.link ?? before.link,
      search: patch.search ?? before.search,
      ai: patch.ai ?? before.ai,
    };

    // Judge what was ASKED for before any cascade. Cascading first would swallow `{ search: true }` while
    // linking is off into a silent no-op, and the caller would believe search was on.
    if (patch.search === true && !requested.link) throw this.refuse("HR_KB_FLAG_ORDER", "Search needs linking to be on first.");
    if (patch.ai === true && !requested.search) throw this.refuse("HR_KB_FLAG_ORDER", "AI needs search to be on first.");

    const next: HrKbLinkFlags = { ...requested };
    if (!next.link) {
      next.search = false;
      next.ai = false;
    }
    if (!next.search) next.ai = false;

    const turnsOn = (next.link && !before.link) || (next.search && !before.search) || (next.ai && !before.ai);
    if (turnsOn && !(await this.entitlements.isModuleEnabled(actor.orgId, HR_MODULE)))
      throw this.refuse("HR_MODULE_NOT_ENABLED", "Enable the HR module before turning on HR documents in the knowledge base.", HttpStatus.CONFLICT);

    const changed = next.link !== before.link || next.search !== before.search || next.ai !== before.ai;
    if (changed) {
      await this.db
        .insert(kbSettings)
        .values({ orgId: actor.orgId, hrmsKbLinkEnabled: next.link, hrmsKbSearchEnabled: next.search, hrmsKbAiEnabled: next.ai })
        .onConflictDoUpdate({
          target: kbSettings.orgId,
          set: { hrmsKbLinkEnabled: next.link, hrmsKbSearchEnabled: next.search, hrmsKbAiEnabled: next.ai, updatedAt: new Date() },
        });
      await this.audit.logCritical({
        action: "kb.hr_link.setting_updated",
        userId: actor.userId,
        orgId: actor.orgId,
        targetId: actor.orgId,
        targetType: "kb_settings",
        before: { ...before },
        after: { ...next },
      });
    }
    return this.getAdmin(actor.orgId);
  }

  private refuse(code: string, message: string, status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY): HttpException {
    return new HttpException({ code, message }, status);
  }
}
