import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbPages, kbSpaces } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../../common/auth/principal";
import { CacheService } from "../../../../common/cache/cache.service";
import { AccessService } from "../../../access/access.service";
import {
  kbSpaceScopeIsAdmin,
  resolveAccessibleSpaceScope,
} from "../kb-acl-cache-key";
import {
  memoizeStandingForRequest,
  standingMemoKey,
} from "./kb-standing-request-memo";
import { getAccessibleProjectIds } from "../../retrieval/kb-project-access.util";
import { resolveRoleSlugs } from "./knowledge-space-scope";
import {
  buildArticleRestrictionBranch,
  buildVisiblePageScope,
} from "./knowledge-page-scope";
import {
  allowed,
  denied,
  notFound,
  type AccessDecision,
  type KbAccessRoute,
  type KbActorStanding,
  type KbPageAction,
  type KbPageScope,
  type KbSpaceScope,
} from "./knowledge-authorization.types";

@Injectable()
export class KnowledgeAuthorizationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async resolveStanding(user: CurrentUserContext): Promise<KbActorStanding> {
    const membershipId =
      user.principal === undefined ? null : actingMembershipId(user.principal);
    return memoizeStandingForRequest(
      standingMemoKey(
        user.orgId,
        user.userId,
        membershipId,
        kbSpaceScopeIsAdmin(user, false),
      ),
      () => this.computeStanding(user, membershipId),
    );
  }

  private async computeStanding(
    user: CurrentUserContext,
    membershipId: number | null,
  ): Promise<KbActorStanding> {
    const [roleSlugs, accessibleProjectIds] = await Promise.all([
      resolveRoleSlugs(this.db, user.orgId, user.userId),
      getAccessibleProjectIds(this.db, user),
    ]);

    const scope = await resolveAccessibleSpaceScope(
      { db: this.db, cache: this.cache, access: this.access },
      user,
      { roleSlugs },
    );

    return {
      orgId: user.orgId,
      userId: user.userId,
      membershipId,
      roleSlugs,
      isOrgOwner: kbSpaceScopeIsAdmin(user, false),
      isKbAdmin: scope.holdsManageKey,
      accessibleSpaceIds: scope.spaceIds,
      accessibleProjectIds,
      permissionsVersion: scope.permissionsVersion,
    };
  }

  async visiblePagePredicate(
    user: CurrentUserContext,
    action: KbPageAction = "view",
  ): Promise<SQL<unknown>> {
    const scope = buildVisiblePageScope(
      await this.resolveStanding(user),
      action,
    );
    return scope.predicate;
  }

  async articleRestrictionPredicate(
    user: CurrentUserContext,
  ): Promise<SQL<unknown> | null> {
    const standing = await this.resolveStanding(user);
    if (standing.isOrgOwner || standing.isKbAdmin) return null;
    return buildArticleRestrictionBranch(standing.orgId, {
      membershipId: standing.membershipId,
      roleSlugs: standing.roleSlugs,
    });
  }

  async invalidateSpaceScope(orgId: string): Promise<void> {
    await this.cache.invalidateNamespace(`kb:acc-spaces:${orgId}`);
  }

  async resolvePageAccess(
    user: CurrentUserContext,
    pageId: number,
    action: KbPageAction,
  ): Promise<AccessDecision<KbPageScope>> {
    const standing = await this.resolveStanding(user);
    if (standing.membershipId === null && !standing.isOrgOwner) {
      return denied("Organization membership required");
    }

    const scope = buildVisiblePageScope(standing, action);
    const row = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, standing.orgId),
        isNull(kbPages.deletedAt),
        scope.predicate,
      ),
      columns: {
        id: true,
        ownerMembershipId: true,
        createdById: true,
        createdByMembershipId: true,
        visibility: true,
        spaceId: true,
        projectId: true,
      },
    });
    if (row === undefined) return notFound();

    return allowed({
      orgId: standing.orgId,
      pageId,
      action,
      via: routeFor(standing, row),
    });
  }

  async resolveSpaceAccess(
    user: CurrentUserContext,
    spaceId: number,
    action: KbPageAction,
  ): Promise<AccessDecision<KbSpaceScope>> {
    const standing = await this.resolveStanding(user);
    if (standing.membershipId === null && !standing.isOrgOwner) {
      return denied("Organization membership required");
    }

    const space = await this.db.query.kbSpaces.findFirst({
      where: and(
        eq(kbSpaces.id, spaceId),
        eq(kbSpaces.orgId, standing.orgId),
        isNull(kbSpaces.deletedAt),
      ),
      columns: { id: true, createdByMembershipId: true },
    });
    if (space === undefined) return notFound();

    const isAdmin = standing.isOrgOwner || standing.isKbAdmin;
    if (!isAdmin && !standing.accessibleSpaceIds.includes(spaceId))
      return notFound();
    if (action === "manage" && !isAdmin) {
      const isSpaceOwner =
        standing.membershipId !== null &&
        space.createdByMembershipId === standing.membershipId;
      if (!isSpaceOwner) return notFound();
    }

    return allowed({
      orgId: standing.orgId,
      spaceId,
      action,
      via: isAdmin ? "admin" : "space",
    });
  }

  async assertPageAccess(
    user: CurrentUserContext,
    pageId: number,
    action: KbPageAction,
  ): Promise<KbPageScope> {
    const decision = await this.resolvePageAccess(user, pageId, action);
    if (decision.outcome === "allowed") return decision.scope;
    if (decision.outcome === "denied")
      throw new ForbiddenException(decision.reason);
    throw new NotFoundException("Page not found");
  }

  async assertSpaceAccess(
    user: CurrentUserContext,
    spaceId: number,
    action: KbPageAction,
  ): Promise<KbSpaceScope> {
    const decision = await this.resolveSpaceAccess(user, spaceId, action);
    if (decision.outcome === "allowed") return decision.scope;
    if (decision.outcome === "denied")
      throw new ForbiddenException(decision.reason);
    throw new NotFoundException("Space not found");
  }
}

function routeFor(
  standing: KbActorStanding,
  row: {
    ownerMembershipId: number | null;
    createdById: string | null;
    createdByMembershipId: number | null;
    visibility: string;
    spaceId: number | null;
    projectId: number | null;
  },
): KbAccessRoute {
  if (standing.isOrgOwner || standing.isKbAdmin) return "admin";
  if (
    standing.membershipId !== null &&
    row.ownerMembershipId === standing.membershipId
  ) {
    return "owner";
  }
  if (row.createdById === standing.userId) return "creator";
  if (
    standing.membershipId !== null &&
    row.createdByMembershipId === standing.membershipId
  ) {
    return "creator";
  }
  if (row.projectId === null && row.visibility === "public") return "public";
  if (row.projectId === null && row.visibility === "org") return "organization";
  if (row.spaceId !== null && standing.accessibleSpaceIds.includes(row.spaceId))
    return "space";
  if (
    row.projectId !== null &&
    standing.accessibleProjectIds.includes(row.projectId)
  ) {
    return "project";
  }
  return "grant";
}
