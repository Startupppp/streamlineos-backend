#!/usr/bin/env node
/**
 * Gate: prohibit fire-and-forget NotificationDispatchService.emit calls.
 *
 * Any service file containing `void this.<name>.emit(` or `void <name>.emit(`
 * followed by notification dispatch patterns must await the call instead of
 * discarding the promise.  A fire-and-forget emit can lose the intent on a
 * crash between the domain write and the notification delivery — exactly what
 * the outbox is designed to prevent.
 *
 * Detection strategy:
 *   1. Collect all .ts service/implementation files (not specs, not modules,
 *      not controllers, not decorators, not guards).
 *   2. For each file, scan for lines that match the fire-and-forget pattern:
 *        void (this\.\w+\.emit|<ident>\.emit)\(
 *      followed within 20 lines by a pattern identifying it as a notification
 *      dispatch (eventKey, targetUserIds, orgId).
 *   3. Report violations and exit non-zero if any found.
 *
 * --self-test : feeds a synthetic bad fixture and asserts the gate bites.
 *
 * Usage:
 *   node src/scripts/check-fire-and-forget.mjs
 *   node src/scripts/check-fire-and-forget.mjs --self-test
 */

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");

const ROOT = new URL("../modules", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

const VOID_EMIT_RE = /\bvoid\s+(?:this\.\w+\s*\.\s*emit|[\w.]+\s*\.\s*emit)\s*\(/;

const VOID_SAVE_POSITION_RE = /\bvoid\s+(?:this\.\w+\s*\.\s*savePosition|[\w.]+\s*\.\s*savePosition)\s*\(/;

const DISPATCH_SIGNAL_RE =
  /\b(?:eventKey|targetUserIds|NotificationDispatchService)\b/;

function collectServiceFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...collectServiceFiles(full));
    } else if (
      stat.isFile() &&
      extname(entry) === ".ts" &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".module.ts") &&
      !entry.endsWith(".controller.ts") &&
      !entry.endsWith(".decorator.ts") &&
      !entry.endsWith(".guard.ts") &&
      !entry.endsWith(".interceptor.ts") &&
      !entry.endsWith(".filter.ts") &&
      !entry.endsWith(".pipe.ts") &&
      !entry.endsWith(".constants.ts") &&
      !entry.endsWith(".types.ts") &&
      !entry.endsWith(".schemas.ts") &&
      !entry.endsWith(".catalog.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

function scanFile(filePath) {
  let src;
  try {
    src = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = src.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (VOID_EMIT_RE.test(line)) {
      const window = lines.slice(i, Math.min(i + 20, lines.length)).join("\n");
      if (DISPATCH_SIGNAL_RE.test(window)) {
        violations.push({ line: i + 1, text: line.trim() });
      }
    }
    if (VOID_SAVE_POSITION_RE.test(line)) {
      violations.push({ line: i + 1, text: line.trim() });
    }
  }
  return violations;
}

if (SELF_TEST) {
  const dir = join(tmpdir(), "check-fire-and-forget-self-test");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}

  const badFile = join(dir, "bad.service.ts");
  writeFileSync(
    badFile,
    [
      "import { Injectable } from '@nestjs/common';",
      "import { NotificationDispatchService } from '../../notifications/notification-dispatch.service';",
      "",
      "@Injectable()",
      "export class BadService {",
      "  constructor(private readonly dispatch: NotificationDispatchService) {}",
      "",
      "  async doWork(orgId: string) {",
      "    void this.dispatch.emit({",
      "      eventKey: 'some.event',",
      "      orgId,",
      "      targetUserIds: ['user-1'],",
      "    }).catch(console.error);",
      "  }",
      "}",
    ].join("\n"),
  );

  const goodFile = join(dir, "good.service.ts");
  writeFileSync(
    goodFile,
    [
      "import { Injectable } from '@nestjs/common';",
      "import { NotificationDispatchService } from '../../notifications/notification-dispatch.service';",
      "",
      "@Injectable()",
      "export class GoodService {",
      "  constructor(private readonly dispatch: NotificationDispatchService) {}",
      "",
      "  async doWork(orgId: string) {",
      "    await this.dispatch.emit({",
      "      eventKey: 'some.event',",
      "      orgId,",
      "      targetUserIds: ['user-1'],",
      "    });",
      "  }",
      "}",
    ].join("\n"),
  );

  const badViolations = scanFile(badFile);
  if (badViolations.length === 0) {
    console.error("SELF-TEST FAILED: gate did not detect the bad fixture");
    process.exit(1);
  }

  const goodViolations = scanFile(goodFile);
  if (goodViolations.length !== 0) {
    console.error("SELF-TEST FAILED: gate produced false-positive on the good fixture");
    process.exit(1);
  }

  const badCheckpointFile = join(dir, "bad-checkpoint.service.ts");
  writeFileSync(
    badCheckpointFile,
    [
      "import { Injectable } from '@nestjs/common';",
      "import { MailSyncCheckpointService } from './mail-sync-checkpoint.service';",
      "",
      "@Injectable()",
      "export class BadCheckpointService {",
      "  constructor(private readonly checkpoints: MailSyncCheckpointService) {}",
      "",
      "  async doWork(orgId: string, accountId: number, folder: string) {",
      "    void this.checkpoints.savePosition(orgId, accountId, folder, null);",
      "  }",
      "}",
    ].join("\n"),
  );

  const goodCheckpointFile = join(dir, "good-checkpoint.service.ts");
  writeFileSync(
    goodCheckpointFile,
    [
      "import { Injectable } from '@nestjs/common';",
      "import { MailSyncCheckpointService } from './mail-sync-checkpoint.service';",
      "",
      "@Injectable()",
      "export class GoodCheckpointService {",
      "  constructor(private readonly checkpoints: MailSyncCheckpointService) {}",
      "",
      "  async doWork(orgId: string, accountId: number, folder: string) {",
      "    await this.checkpoints.savePosition(orgId, accountId, folder, null);",
      "  }",
      "}",
    ].join("\n"),
  );

  const badCheckpointViolations = scanFile(badCheckpointFile);
  if (badCheckpointViolations.length === 0) {
    console.error("SELF-TEST FAILED: gate did not detect the bad checkpoint fixture");
    process.exit(1);
  }

  const goodCheckpointViolations = scanFile(goodCheckpointFile);
  if (goodCheckpointViolations.length !== 0) {
    console.error("SELF-TEST FAILED: gate produced false-positive on the good checkpoint fixture");
    process.exit(1);
  }

  console.log(
    `SELF-TEST PASSED: detected ${badViolations.length} violation(s) in bad emit fixture, 0 in good emit fixture; detected ${badCheckpointViolations.length} violation(s) in bad checkpoint fixture, 0 in good checkpoint fixture`,
  );
  process.exit(0);
}

const files = collectServiceFiles(ROOT);
if (files.length < 50) {
  console.error(`ERROR: scan found only ${files.length} files — too few to be a real scan`);
  process.exit(1);
}

const allViolations = [];
for (const file of files) {
  const violations = scanFile(file);
  for (const v of violations) {
    allViolations.push({ file: file.replace(/\\/g, "/"), ...v });
  }
}

if (allViolations.length === 0) {
  console.log(`check:fire-and-forget PASSED — scanned ${files.length} files, 0 violations`);
  process.exit(0);
} else {
  console.error(`check:fire-and-forget FAILED — ${allViolations.length} fire-and-forget emit violation(s):`);
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error("");
  console.error("Fix: replace  void this.<dispatch>.emit({...}).catch(...)");
  console.error("with: await this.<dispatch>.emit({...})");
  process.exit(1);
}
