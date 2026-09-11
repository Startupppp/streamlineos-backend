import { constants as zlibConstants, type BrotliOptions } from "node:zlib";
import type { Request, Response } from "express";

/**
 * HTTP response compression, DECLARED rather than inherited from a library default.
 *
 * `app.use(compression())` took no options, so every property PRD-C089 asks for was a
 * default of `compression@1.8.1` that nothing in this repository stated, tested or
 * could notice changing:
 *  - the 1 KB minimum size lived in `index.js:73`,
 *  - the already-compressed exclusions came from the `compressible` npm database,
 *  - Brotli preference came from `PREFERRED_ENCODING = ['br','gzip']`,
 *  - and `check:compression` asserts only that the literal string `compression()`
 *    appears in `main.ts`, so all four could vanish in a minor upgrade and the gate
 *    would stay green.
 * Stating them here makes them reviewable, testable and diff-able. The values chosen
 * are the ones that were already in force, so this is a declaration of the status quo
 * plus the two exclusions that were NOT in force.
 *
 * THE TWO THINGS THAT WERE NOT IN FORCE.
 *
 * 1. `application/pdf` IS in the `compressible` database, so every PDF this API
 *    returns was being gzipped — a payslip, an offer letter, a Form 16, a quote
 *    document. A PDF's own object streams are already Flate-compressed, so the second
 *    pass buys nothing measurable and costs CPU on the response path of the largest
 *    bodies the service sends. `ALREADY_COMPRESSED` excludes it explicitly, along with
 *    the image/video/archive families, rather than trusting a third-party table.
 *
 * 2. BREACH. Compression plus a secret in the body plus attacker-influenced text in
 *    the same body plus a cross-origin size oracle is a secret-recovery attack, and
 *    this deployment has the first, third and fourth: `app.enableCors({ credentials:
 *    true })`. Three routes return a bearer token or a plaintext API key in a
 *    compressible JSON body — `POST /notifications/events/token`, the auth token mint,
 *    and API-token creation. `NO_COMPRESSION_HEADER` is the opt-out a handler sets on
 *    such a response; `Cache-Control: no-transform` also works and is honoured by the
 *    library itself. Neither is a substitute for the handler declaring it, and the
 *    three routes above are named in report 04 for their owners — this file supplies
 *    the mechanism, not the adoption.
 *
 * The filter is exported PURE so `compression.config.spec.ts` can drive it with header
 * pairs rather than a live server: a filter proven only by "the app booted" is a filter
 * nobody has read.
 */

/** A handler sets this on a response that must never be compressed. Value is ignored. */
export const NO_COMPRESSION_HEADER = "x-no-compression";

/**
 * Compressing these buys nothing and costs CPU on the response path. Matched on the
 * media type prefix, so `image/png`, `image/svg+xml` and `application/pdf; charset=…`
 * all resolve. `image/svg+xml` is the deliberate exception: SVG is XML, compresses
 * well, and is NOT excluded.
 */
export const ALREADY_COMPRESSED: readonly string[] = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/x-bzip",
  "application/x-bzip2",
  "application/vnd.rar",
  "font/woff",
  "font/woff2",
  "application/font-woff",
];

/** SVG is XML and compresses well; it must survive the `image/` prefix rule. */
const COMPRESSIBLE_EXCEPTIONS: readonly string[] = ["image/svg+xml"];

/**
 * The minimum body worth compressing. Below roughly one MTU the deflate header and the
 * CPU cost exceed the saving, and for a Server-Sent-Events frame buffering to reach a
 * threshold is worse than not compressing at all. 1024 is `compression`'s own default,
 * restated so an upgrade that changed it would change a number in this file.
 */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

/** Brotli quality. 4 is the library default: near-gzip CPU, better ratio. */
export const BROTLI_QUALITY = 4;

function headerValue(res: Response, name: string): string {
  const value = res.getHeader(name);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "number") return String(value);
  return "";
}

/** The media type without parameters, lowercased. */
export function normalizeContentType(raw: string): string {
  const [type] = raw.split(";");
  return (type ?? "").trim().toLowerCase();
}

export function isAlreadyCompressed(contentType: string): boolean {
  const type = normalizeContentType(contentType);
  if (type === "") return false;
  if (COMPRESSIBLE_EXCEPTIONS.includes(type)) return false;
  return ALREADY_COMPRESSED.some((prefix) => type.startsWith(prefix));
}

/**
 * `false` means do not compress this response.
 *
 * Order matters and is deliberate: the explicit opt-out is checked FIRST, so a handler
 * that marks a token response can never be overruled by a content type that happens to
 * look compressible. An already-encoded body is refused next — re-encoding a
 * `Content-Encoding: gzip` body corrupts it.
 */
export function shouldCompress(_req: Request, res: Response): boolean {
  if (res.getHeader(NO_COMPRESSION_HEADER) !== undefined) return false;
  if (/\bno-transform\b/i.test(headerValue(res, "cache-control"))) return false;
  if (headerValue(res, "content-encoding") !== "") return false;
  return !isAlreadyCompressed(headerValue(res, "content-type"));
}

export interface HttpCompressionOptions {
  threshold: number;
  filter: typeof shouldCompress;
  brotli: BrotliOptions;
}

/**
 * Brotli quality is set through `opts.brotli.params`, keyed by
 * `zlib.constants.BROTLI_PARAM_QUALITY` — which is **1**, not 11. 11 is the maximum
 * QUALITY VALUE and reads like the parameter id; writing it as the key would have set
 * `BROTLI_PARAM_MODE` instead and silently left quality at the default. The constant is
 * imported rather than transcribed for exactly that reason.
 */
export function httpCompressionOptions(): HttpCompressionOptions {
  return {
    threshold: COMPRESSION_THRESHOLD_BYTES,
    filter: shouldCompress,
    brotli: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } },
  };
}
