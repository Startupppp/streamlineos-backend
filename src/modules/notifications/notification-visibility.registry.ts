import { Injectable, Logger } from "@nestjs/common";

/**
 * Answers "can this user still see this record, right now". Returning false
 * suppresses the notification for that recipient.
 *
 * Implementations must be safe to call with no request context: the check runs in
 * the dispatch path, which may be a cron sweep or a post-commit hook, so nothing
 * here may read `req.rbacScope` or any AsyncLocalStorage request state. Pass the
 * scope explicitly or resolve it from `(orgId, userId)`.
 */
/**
 * Resource kinds that have a resolver registered by their owning module. A catalog
 * event may only declare a kind from this list — `notification-catalog-integrity.spec.ts`
 * enforces it, so annotating an event without shipping its resolver fails CI rather
 * than silently suppressing every delivery at runtime.
 */
export const IMPLEMENTED_VISIBILITY_RESOURCE_KINDS = ["kb.page", "build.ticket"] as const;

export type VisibilityResolver = (
  orgId: string,
  userId: string,
  entityId: string,
) => Promise<boolean>;

/**
 * PIPE-003. Owning modules register their own resolver here; the notifications
 * module never imports a domain module. That inversion is what keeps the import
 * graph acyclic — Build/KB/Support/CRM already depend on NotificationsModule to
 * emit, so the reverse edge would be a cycle (CLAUDE.md §24).
 */
@Injectable()
export class NotificationVisibilityRegistry {
  private readonly logger = new Logger(NotificationVisibilityRegistry.name);
  private readonly resolvers = new Map<string, VisibilityResolver>();

  register(resourceKind: string, resolver: VisibilityResolver): void {
    if (this.resolvers.has(resourceKind))
      this.logger.warn(`Visibility resolver for "${resourceKind}" was replaced`);
    this.resolvers.set(resourceKind, resolver);
  }

  has(resourceKind: string): boolean {
    return this.resolvers.has(resourceKind);
  }

  registeredKinds(): string[] {
    return [...this.resolvers.keys()];
  }

  /**
   * Deny-by-default. A declared resource kind with no registered resolver, a
   * declared kind with no entity id, and a resolver that throws all return false —
   * an event that says it needs an authorization check does not get delivered
   * because the check is unavailable (§0.5, §20).
   */
  async canSee(
    resourceKind: string | undefined,
    orgId: string,
    userId: string,
    entityId: string | undefined,
  ): Promise<boolean> {
    if (!resourceKind) return true;

    const resolver = this.resolvers.get(resourceKind);
    if (!resolver) {
      this.logger.error(
        `No visibility resolver registered for "${resourceKind}" — denying delivery. ` +
          `Register one in the owning module's onModuleInit, or clear visibilityResourceKind on the event.`,
      );
      return false;
    }

    if (!entityId) {
      this.logger.error(
        `Event declares visibilityResourceKind "${resourceKind}" but carries no entityId — denying delivery.`,
      );
      return false;
    }

    try {
      return await resolver(orgId, userId, entityId);
    } catch (error: unknown) {
      this.logger.error(
        `Visibility resolver "${resourceKind}" failed for user ${userId} in org ${orgId}: ` +
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      return false;
    }
  }
}
