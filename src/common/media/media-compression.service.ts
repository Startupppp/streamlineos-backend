import { Injectable, Logger } from "@nestjs/common";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, readFile, unlink } from "fs/promises";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export interface CompressionResult {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

const COMPRESSIBLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "image/avif",
  "image/heic",
  "image/heif",
]);

function isAlreadyCompressedByMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  const b0 = buffer[0] ?? 0;
  const b1 = buffer[1] ?? 0;
  const b2 = buffer[2] ?? 0;
  const b3 = buffer[3] ?? 0;
  const b4 = buffer[4] ?? 0;
  const b5 = buffer[5] ?? 0;
  const b6 = buffer[6] ?? 0;
  if (b0 === 0x50 && b1 === 0x4b && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) return true;
  if (b0 === 0x1f && b1 === 0x8b) return true;
  if (b0 === 0x42 && b1 === 0x5a && b2 === 0x68) return true;
  if (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc && b3 === 0xaf && b4 === 0x27 && b5 === 0x1c) return true;
  if (b0 === 0xfd && b1 === 0x37 && b2 === 0x7a && b3 === 0x58 && b4 === 0x5a && b5 === 0x00) return true;
  if (b0 === 0x04 && b1 === 0x22 && b2 === 0x4d && b3 === 0x18) return true;
  if (b0 === 0x52 && b1 === 0x61 && b2 === 0x72 && b3 === 0x21 && b4 === 0x1a && b5 === 0x07) return true;
  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return true;
  if (b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) return false;
  if (b0 === 0x53 && b1 === 0x51 && b2 === 0x4c && b3 === 0x69 && b4 === 0x74 && b5 === 0x65) return true;
  if (b0 === 0x00 && b3 === 0x00 && (b4 === 0x6a || b4 === 0x66 || b4 === 0x4a || b4 === 0x46) &&
      (b5 === 0x50 || b5 === 0x46 || b5 === 0x4c || b5 === 0x58) &&
      (b6 === 0x32 || b6 === 0x4c || b6 === 0x46)) return false;
  return false;
}

const ALREADY_COMPRESSED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/x-matroska",
  "video/ogg",
]);

const MAX_IMAGE_DIMENSION = 1920;
const WEBP_QUALITY = 82;

const VIDEO_MAX_DIMENSION = 1080;
const VIDEO_CRF = 28;
const VIDEO_AUDIO_BITRATE = "128k";

/**
 * Every transform in this file is bounded three ways, because "asynchronous" on
 * its own is not a bound — it only moves an unbounded cost somewhere harder to
 * see.
 *
 *   INPUT   a decompression bomb is refused before any decoder allocates
 *   TIME    the work is killed, not merely abandoned; an abandoned ffmpeg keeps
 *           its CPU
 *   THREADS one transform may not take every core from every other request
 */
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_TRANSCODE_INPUT_BYTES = 64 * 1024 * 1024;
const TRANSCODE_TIMEOUT_MS = 60_000;
const FFMPEG_THREADS = 2;

/**
 * The thread bound is NOT set here. `sharp.concurrency()` is a call into the
 * native libvips binding, and calling it at module load makes every importer of
 * this file — every spec that reaches it through StorageService — depend on
 * that binding being real. A spec that stubs `jest.mock("sharp", …)` then dies
 * at import rather than at use, which is exactly what happened to
 * kb-media.service.spec.ts. How many transforms may decode at once is
 * MediaTransformRunner's ceiling instead, which is where the answer belongs:
 * it bounds ffmpeg and sharp together, and it is testable without a native
 * binding.
 */
const SHARP_INPUT_LIMITS = { limitInputPixels: MAX_IMAGE_PIXELS } as const;

export interface PlannedOutput {
  mimeType: string;
  fileName: string;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function uniqueTmpPath(ext: string): string {
  return join(tmpdir(), `sc-media-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

/**
 * Racing a transcode against a timer does not bound it: the promise settles and
 * the ffmpeg process keeps encoding at full tilt with nobody left to notice.
 * The timer here holds the command handle and SIGKILLs it, which is the only
 * thing that actually returns the CPU.
 */
function transcodeToMp4(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const command = ffmpeg(inputPath)
      .outputOptions([
        "-c:v libx264",
        `-crf ${VIDEO_CRF}`,
        "-preset fast",
        "-movflags +faststart",
        `-threads ${FFMPEG_THREADS}`,
        `-vf scale='if(gt(iw,${VIDEO_MAX_DIMENSION}),${VIDEO_MAX_DIMENSION},-2)':'if(gt(ih,${VIDEO_MAX_DIMENSION}),${VIDEO_MAX_DIMENSION},-2)':flags=lanczos`,
        "-c:a aac",
        `-b:a ${VIDEO_AUDIO_BITRATE}`,
      ])
      .output(outputPath)
      .on("end", () => settle())
      .on("error", (err: Error) => settle(err));

    timer = setTimeout(() => {
      try {
        command.kill("SIGKILL");
      } catch {
        /* the process may already have exited between the timer and the kill */
      }
      settle(new Error(`transcode exceeded ${TRANSCODE_TIMEOUT_MS}ms and was killed`));
    }, TRANSCODE_TIMEOUT_MS);

    command.run();
  });
}

@Injectable()
export class MediaCompressionService {
  private readonly logger = new Logger(MediaCompressionService.name);

  /**
   * The output name and type this compressor WILL produce, decided without
   * doing the work.
   *
   * The object key has to be chosen on the request thread — the caller is given
   * it in the response — while the compression that decides the stored format
   * runs later, off that thread. Those two facts are only compatible if the
   * format decision is separable from the encoding, so it lives here and
   * `compress` is required to agree with it whenever it succeeds. When a
   * transform fails or declines, `compress` returns the original bytes and the
   * caller records the MEASURED type on the quarantine row; the key's extension
   * is decorative in that case, because every read serves the type the object
   * store holds, not the one the key spells.
   */
  planOutput(buffer: Buffer, mimeType: string, fileName: string): PlannedOutput {
    if (isAlreadyCompressedByMagicBytes(buffer)) return { mimeType, fileName };

    if (COMPRESSIBLE_IMAGE_TYPES.has(mimeType))
      return { mimeType: "image/webp", fileName: `${stripExtension(fileName)}.webp` };

    if (mimeType.startsWith("video/")) {
      if (ALREADY_COMPRESSED_VIDEO_TYPES.has(mimeType)) return { mimeType, fileName };
      if (buffer.length > MAX_TRANSCODE_INPUT_BYTES) return { mimeType, fileName };
      return { mimeType: "video/mp4", fileName: `${stripExtension(fileName)}.mp4` };
    }

    return { mimeType, fileName };
  }

  async compress(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<CompressionResult> {
    if (isAlreadyCompressedByMagicBytes(buffer))
      return { buffer, mimeType, fileName };

    if (COMPRESSIBLE_IMAGE_TYPES.has(mimeType)) {
      return this.compressImage(buffer, mimeType, fileName);
    }

    if (mimeType.startsWith("video/")) {
      if (ALREADY_COMPRESSED_VIDEO_TYPES.has(mimeType))
        return { buffer, mimeType, fileName };
      /**
       * Refused rather than queued. A transcode is the one transform whose cost
       * grows without a ceiling in the input size, and this endpoint's callers
       * include an unauthenticated widget.
       */
      if (buffer.length > MAX_TRANSCODE_INPUT_BYTES) {
        this.logger.warn("Video too large to transcode, storing original", {
          fileName,
          bytes: buffer.length,
          limit: MAX_TRANSCODE_INPUT_BYTES,
        });
        return { buffer, mimeType, fileName };
      }
      return this.transcodeVideo(buffer, mimeType, fileName);
    }

    return { buffer, mimeType, fileName };
  }

  private async compressImage(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<CompressionResult> {
    try {
      const compressed = await sharp(buffer, SHARP_INPUT_LIMITS)
        .rotate()
        .resize({ width: MAX_IMAGE_DIMENSION, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      return {
        buffer: compressed,
        mimeType: "image/webp",
        fileName: `${stripExtension(fileName)}.webp`,
      };
    } catch (err) {
      this.logger.warn(`Image compression failed, storing original: ${String(err)}`, { fileName });
      return { buffer, mimeType, fileName };
    }
  }

  private async transcodeVideo(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<CompressionResult> {
    const inputPath = uniqueTmpPath(".input");
    const outputPath = uniqueTmpPath(".mp4");

    try {
      await writeFile(inputPath, buffer);
      await transcodeToMp4(inputPath, outputPath);

      const transcoded = await readFile(outputPath);

      if (transcoded.length >= buffer.length) {
        this.logger.warn("Video transcode produced no size saving, storing original", {
          fileName,
          transcodedBytes: transcoded.length,
          originalBytes: buffer.length,
        });
        return { buffer, mimeType, fileName };
      }

      return {
        buffer: transcoded,
        mimeType: "video/mp4",
        fileName: `${stripExtension(fileName)}.mp4`,
      };
    } catch (err) {
      this.logger.warn(`Video transcode failed, storing original: ${String(err)}`, { fileName });
      return { buffer, mimeType, fileName };
    } finally {
      await Promise.allSettled([unlink(inputPath), unlink(outputPath)]);
    }
  }
}
