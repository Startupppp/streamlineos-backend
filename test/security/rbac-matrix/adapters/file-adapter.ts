import { DRIZZLE } from "src/db/drizzle.constants";
import { FilesController } from "src/modules/build/files/files.controller";
import { FilesService } from "src/modules/build/files/files.service";
import { StorageController } from "src/modules/storage/storage.controller";
import { StorageService } from "src/modules/storage/storage.service";
import { FileQuarantineService } from "src/modules/storage/file-quarantine.service";
import { isWellFormedStorageKey } from "src/modules/storage/storage-key";
import type { Observation } from "../matrix.types";
import type { Standing } from "../standings";
import { standIn, type WorldDb } from "../world-db";
import { sendHttp } from "./http-adapter";
import { filesService, type SignedObject } from "./real-services";

function urlOf(body: unknown): string | undefined {
  return body !== null && typeof body === "object" && "url" in body && typeof body.url === "string" ? body.url : undefined;
}

const downloadSigned: SignedObject[] = [];
const mintSigned: SignedObject[] = [];

function storageProviders(world: WorldDb, signed: SignedObject[]) {
  return [
    { provide: DRIZZLE, useValue: world.db },
    {
      provide: StorageService,
      useValue: standIn<StorageService>({
        isConfigured: () => true,
        isValidFileKey: (key: string) => isWellFormedStorageKey(key),
        getFileKeyFromUrl: () => "",
        getFileUrl: async (orgId: string, key: string): Promise<string> => {
          signed.push({ orgId, key });
          return `https://files.invalid/${key}?sig=${orgId}`;
        },
      }),
    },
    { provide: FileQuarantineService, useValue: standIn<FileQuarantineService>({ isKeyBlocked: async () => false }) },
  ];
}

export async function downloadKey(world: WorldDb, standing: Standing, orgId: string, key: string): Promise<Observation> {
  const signed = downloadSigned;
  signed.length = 0;
  const exchange = await sendHttp(world, {
    controllers: [StorageController],
    services: storageProviders(world, signed),
    verb: "get",
    path: `/storage/download?key=${encodeURIComponent(key)}`,
    standing,
    orgId,
  });
  return {
    outcome: exchange.outcome,
    checks: {
      signsOnlyWhenVerified: (exchange.outcome === "allow") === (signed.length === 1),
      signsTheVerifiedKeyForTheCaller: signed.every((entry) => entry.key === key && entry.orgId === orgId),
      returnsTheSignedUrl: exchange.outcome !== "allow" || urlOf(exchange.body) !== undefined,
    },
  };
}

export async function signThenDownload(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  projectId: number,
  fileId: number,
): Promise<Observation> {
  const signed = mintSigned;
  signed.length = 0;
  const minted = await sendHttp(world, {
    controllers: [FilesController],
    services: [{ provide: FilesService, useValue: filesService(world, signed) }],
    verb: "get",
    path: `/build/${projectId}/files/${fileId}/url`,
    permissionKey: "build:files:view",
    standing,
    orgId,
  });
  const signedKey = signed[0]?.key;
  if (minted.outcome !== "allow" || signedKey === undefined)
    return {
      outcome: minted.outcome,
      checks: { noSignatureOnRefusal: signed.length === 0, routeAskedForItsKey: minted.asked.includes("build:files:view") },
    };
  const verified = await downloadKey(world, standing, orgId, signedKey);
  return {
    outcome: verified.outcome,
    checks: {
      ...verified.checks,
      signedKeyIsUnderCallerOrg: signedKey.startsWith(`${orgId}/`),
      mintedUrlNamesTheKey: urlOf(minted.body)?.includes(signedKey) === true,
    },
  };
}
