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
import { kbAclCacheKey } from "../kb-acl-cache-key";
import { getAccessibleProjectIds } from "../../retrieval/kb-project-access.util";
import {
  computeAccessibleSpaceIds,
  resolveRoleSlugs,
} from "./knowledge-space-scope";
import { buildVisiblePageScope } from "./knowledge-page-scope";
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

const KB_MANAGE_SPACES = "kb:spaces:manage";
const SPACE_SCOPE_TTL_SECONDS = 60;

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
    const [isKbAdmin, permissionsVersion, roleSlugs, accessibleProjectIds] =
      await Promise.all([
        this.access.holds(user, KB_MANAGE_SPACES),
        this.access.getPermissionsVersion(user.orgId),
        resolveRoleSlugs(this.db, user.orgId, user.userId),
        getAccessibleProjectIds(this.db, user),
      ]);

    const isAdmin = isKbAdmin || user.isOrgOwner;
    const accessibleSpaceIds = await this.cache.cachedVersioned(
      `kb:acc-spaces:${user.orgId}`,
      kbAclCacheKey(user.userId, {
        orgId: user.orgId,
        permissionsVersion,
        membershipId,
      }),
      () =>
        computeAccessibleSpaceIds(
          this.db,
          user.orgId,
          membershipId,
          isAdmin,
          () => Promise.resolve(roleSlugs),
        ),
      SPACE_SCOPE_TTL_SECONDS,
    );

    return {
      orgId: user.orgId,
      userId: user.userId,
      membershipId,
      roleSlugs,
      isOrgOwner: user.isOrgOwner,
      isKbAdmin,
      accessibleSpaceIds,
      accessibleProjectIds,
      permissionsVersion,
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
