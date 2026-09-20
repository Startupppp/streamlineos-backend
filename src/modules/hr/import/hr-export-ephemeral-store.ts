import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import type { FileStreamResult } from "../../storage/storage.service";

export const EPHEMERAL_FILE_KEY_PREFIX = "ephemeral:";
export const EPHEMERAL_TTL_MS = 60 * 60 * 1000;

export function ephemeralFileKey(jobId: string): string {
  return `${EPHEMERAL_FILE_KEY_PREFIX}${jobId}`;
}

export function isEphemeralFileKey(fileKey: string): boolean {
  return fileKey.startsWith(EPHEMERAL_FILE_KEY_PREFIX);
}

export function ephemeralJobIdFromFileKey(fileKey: string): string {
  return fileKey.slice(EPHEMERAL_FILE_KEY_PREFIX.length);
}

interface EphemeralEntry {
  tempPath: string;
  mimeType: string;
  fileSizeBytes: number;
  expiresAt: number;
}

/**
 * In-process CSV artifacts when private object storage is unset.
 * Keys are `orgId:jobId`. Entries expire after {@link EPHEMERAL_TTL_MS}.
 */
class HrExportEphemeralStore {
  private readonly entries = new Map<string, EphemeralEntry>();

  private mapKey(orgId: string, jobId: string): string {
    return `${orgId}:${jobId}`;
  }

  put(
    orgId: string,
    jobId: string,
    artifact: {
      tempPath: string;
      mimeType: string;
      fileSizeBytes: number;
      expiresAt?: number;
    },
  ): void {
    this.sweep();
    this.entries.set(this.mapKey(orgId, jobId), {
      tempPath: artifact.tempPath,
      mimeType: artifact.mimeType,
      fileSizeBytes: artifact.fileSizeBytes,
      expiresAt: artifact.expiresAt ?? Date.now() + EPHEMERAL_TTL_MS,
    });
  }

  get(orgId: string, jobId: string): EphemeralEntry | null {
    this.sweep();
    const key = this.mapKey(orgId, jobId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      void this.delete(orgId, jobId);
      return null;
    }
    return entry;
  }

  take(orgId: string, jobId: string): EphemeralEntry | null {
    const entry = this.get(orgId, jobId);
    if (!entry) return null;
    this.entries.delete(this.mapKey(orgId, jobId));
    return entry;
  }

  async delete(orgId: string, jobId: string): Promise<void> {
    const key = this.mapKey(orgId, jobId);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (entry) await unlink(entry.tempPath).catch(() => undefined);
  }

  openStream(orgId: string, jobId: string): FileStreamResult | null {
    const entry = this.get(orgId, jobId);
    if (!entry) return null;
    return {
      body: createReadStream(entry.tempPath),
      contentType: entry.mimeType,
      contentLength: entry.fileSizeBytes,
    };
  }

  /** Test helper — drops map entries without unlinking (tests use fake paths). */
  clear(): void {
    this.entries.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.entries.delete(key);
      void unlink(entry.tempPath).catch(() => undefined);
    }
  }
}

export const hrExportEphemeralStore = new HrExportEphemeralStore();
