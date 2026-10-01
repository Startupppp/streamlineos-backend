import { FilesService } from "src/modules/build/files/files.service";
import type { AuditService } from "src/common/audit/audit.service";
import type { StorageService } from "src/modules/storage/storage.service";
import { settle } from "../matrix-runner";
import type { Observation } from "../matrix.types";
import { accessFor, actorFor, type Standing } from "../standings";
import { standIn, type WorldDb } from "../world-db";

export async function signedFileUrl(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  projectId: number,
  fileId: number,
): Promise<Observation> {
  const signed: string[] = [];
  const storage = standIn<StorageService>({
    getFileUrl: async (ownerOrg: string, storageKey: string): Promise<string> => {
      signed.push(`${ownerOrg}|${storageKey}`);
      return `https://files.invalid/${ownerOrg}/${storageKey}?sig=1`;
    },
  });
  const audit = standIn<AuditService>({ log: () => undefined });
  const service = new FilesService(world.db, accessFor(world), audit, storage);
  return settle(
    () => service.getSignedUrl(actorFor(standing, orgId), projectId, fileId),
    (value) => ({
      signsOnlyCallerOrgKeys: signed.every((entry) => entry.startsWith(`${orgId}|${orgId}/`)),
      noSignatureOnRefusal: value !== undefined || signed.length === 0,
    }),
  );
}
