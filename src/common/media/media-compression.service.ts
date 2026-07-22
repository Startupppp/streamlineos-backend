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

const MAX_IMAGE_DIMENSION = 1920;
const WEBP_QUALITY = 82;

const VIDEO_MAX_DIMENSION = 1080;
const VIDEO_CRF = 28;
const VIDEO_AUDIO_BITRATE = "128k";

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function uniqueTmpPath(ext: string): string {
  return join(tmpdir(), `sc-media-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

function transcodeToMp4(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-c:v libx264",
        `-crf ${VIDEO_CRF}`,
        "-preset fast",
        "-movflags +faststart",
        `-vf scale='if(gt(iw,${VIDEO_MAX_DIMENSION}),${VIDEO_MAX_DIMENSION},-2)':'if(gt(ih,${VIDEO_MAX_DIMENSION}),${VIDEO_MAX_DIMENSION},-2)':flags=lanczos`,
        "-c:a aac",
        `-b:a ${VIDEO_AUDIO_BITRATE}`,
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

@Injectable()
export class MediaCompressionService {
  private readonly logger = new Logger(MediaCompressionService.name);

  async compress(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<CompressionResult> {
    if (COMPRESSIBLE_IMAGE_TYPES.has(mimeType)) {
      return this.compressImage(buffer, mimeType, fileName);
    }

    if (mimeType.startsWith("video/")) {
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
      const compressed = await sharp(buffer)
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
      this.logger.warn(`Image compression failed for "${fileName}", storing original: ${String(err)}`);
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
        this.logger.warn(
          `Video transcode for "${fileName}" produced no size saving (${transcoded.length} >= ${buffer.length}), storing original`,
        );
        return { buffer, mimeType, fileName };
      }

      return {
        buffer: transcoded,
        mimeType: "video/mp4",
        fileName: `${stripExtension(fileName)}.mp4`,
      };
    } catch (err) {
      this.logger.warn(`Video transcode failed for "${fileName}", storing original: ${String(err)}`);
      return { buffer, mimeType, fileName };
    } finally {
      await Promise.allSettled([unlink(inputPath), unlink(outputPath)]);
    }
  }
}
