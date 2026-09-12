import { registerAfterCommit } from "../../common/tenant/tenant-context";
import type { StorageService } from "../storage/storage.service";
import type { MediaTransformRunner } from "../storage/media-transform.runner";

export interface PlannedMedia {
  key: string;
  size: number;
  mimeType: string;
}

export interface PendingMediaTransform {
  buffer: Buffer;
  key: string;
  fileName: string;
  mimeType: string;
}

/**
 * Settles the object key without running a decoder, and records the bytes for
 * the transform that follows.
 *
 * The widget submit endpoint is `@Public()`: an unauthenticated caller may post
 * a 100MB recording, and transcoding it inline held the request for as long as
 * ffmpeg wanted. Planning here lets the submission row be written with a key
 * that is already final while the encoding happens off the request.
 */
export async function planMedia(
  storage: StorageService,
  orgId: string,
  folder: string,
  file: { buffer: Buffer; fileName: string; mimeType: string },
  pending: PendingMediaTransform[],
): Promise<PlannedMedia> {
  const { buffer, fileName, mimeType } = file;
  const planned = await storage.planUpload(orgId, buffer, folder, fileName, mimeType);
  pending.push({ buffer, key: planned.key, fileName, mimeType });
  return { key: planned.key, size: buffer.length, mimeType: planned.plannedMimeType };
}

/**
 * Queued only once the submission row has committed, so a rolled-back
 * submission never leaves an object at a key nothing references. A refused job
 * is logged by the runner and leaves a row pointing at a key with no object,
 * which is the recoverable direction: the storage sweep already reconciles it,
 * whereas an unreferenced object is invisible to every cleanup path.
 */
export async function queueMediaTransforms(
  storage: StorageService,
  transforms: MediaTransformRunner,
  orgId: string,
  pending: PendingMediaTransform[],
): Promise<void> {
  for (const item of pending) {
    const enqueue = async (): Promise<void> => {
      transforms.submit({
        name: "feedbucket.media.compress",
        orgId,
        run: async () => {
          await storage.compressToKey(orgId, item.buffer, item.key, item.fileName, item.mimeType);
        },
        compensate: async () => {
          await storage.deleteFileIfPresent(orgId, item.key);
        },
      });
    };
    if (!registerAfterCommit(enqueue)) await enqueue();
  }
}
