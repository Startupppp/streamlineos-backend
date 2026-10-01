import type { CacheService } from "src/common/cache/cache.service";
import type { AuditService } from "src/common/audit/audit.service";
import type { NotificationDispatchService } from "src/modules/notifications/notification-dispatch.service";
import type { RolePermissionService } from "src/modules/rbac/role-permission.service";
import { RoleMemberService } from "src/modules/rbac/role-member.service";
import { RolesService } from "src/modules/rbac/roles.service";
import { IntakeService, MilestonesService, ViewsService } from "src/modules/build/execution/workspace.service";
import { ModulesService } from "src/modules/build/execution/modules.service";
import { ProjectsCustomFieldsService, ProjectsWebhooksService } from "src/modules/build/core";
import { WebhookEndpointService } from "src/modules/integrations/core/webhook-endpoint.service";
import { ProjectsTicketLinksService } from "src/modules/build/core/tickets/projects-ticket-links.service";
import { FilesService } from "src/modules/build/files/files.service";
import type { StorageService } from "src/modules/storage/storage.service";
import { accessFor } from "../standings";
import { standIn, type WorldDb } from "../world-db";

export const cache = standIn<CacheService>({
  invalidate: async () => undefined,
  invalidateMany: async () => undefined,
  invalidateNamespace: async () => undefined,
  invalidateNamespaceForOrg: async () => undefined,
  cachedVersioned: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load(),
});

export const audit = standIn<AuditService>({ log: () => undefined, logCritical: async () => undefined });

export interface SignedObject {
  readonly orgId: string;
  readonly key: string;
}

export function signingStorage(signed: SignedObject[]): StorageService {
  return standIn<StorageService>({
    isConfigured: () => true,
    getFileUrl: async (orgId: string, key: string): Promise<string> => {
      signed.push({ orgId, key });
      return `https://files.invalid/${key}?sig=${orgId}`;
    },
  });
}

export function roleMemberService(world: WorldDb): RoleMemberService {
  const dispatch = standIn<NotificationDispatchService>({ emit: async () => ({ delivered: 0 }) });
  return new RoleMemberService(world.db, cache, dispatch, accessFor(world));
}

export function rolesService(world: WorldDb): RolesService {
  return new RolesService(world.db, audit, accessFor(world), standIn<RolePermissionService>({}), roleMemberService(world), cache);
}

export function milestonesService(world: WorldDb): MilestonesService {
  return new MilestonesService(world.db, accessFor(world), audit);
}

export function viewsService(world: WorldDb): ViewsService {
  return new ViewsService(world.db, accessFor(world));
}

export function intakeService(world: WorldDb): IntakeService {
  return new IntakeService(world.db, standIn({}), accessFor(world));
}

export function modulesService(world: WorldDb): ModulesService {
  return new ModulesService(world.db);
}

export function webhooksService(world: WorldDb): ProjectsWebhooksService {
  return new ProjectsWebhooksService(world.db, new WebhookEndpointService(world.db));
}

export function customFieldsService(world: WorldDb): ProjectsCustomFieldsService {
  return new ProjectsCustomFieldsService(world.db, accessFor(world));
}

export function ticketLinksService(world: WorldDb): ProjectsTicketLinksService {
  return new ProjectsTicketLinksService(world.db, accessFor(world));
}

export function filesService(world: WorldDb, signed: SignedObject[]): FilesService {
  return new FilesService(world.db, accessFor(world), audit, signingStorage(signed));
}
