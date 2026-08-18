import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bundleDownFileNames,
  bundleFileNames,
  rootMigration,
  type BundleDownFileName,
  type BundleFileName,
} from "./bundle-config";
import { fail } from "./bundle-error";

export type SqlFileSnapshot = {
  name: BundleFileName;
  sql: string;
  sha256: string;
};

export type RootMigrationSnapshot = {
  name: string;
  createdAt: number;
  sha256: string;
};

export type SqlDownFileSnapshot = {
  name: BundleDownFileName;
  sql: string;
  sha256: string;
};

export type BundleSnapshot = {
  root: RootMigrationSnapshot;
  files: SqlFileSnapshot[];
  downFiles: SqlDownFileSnapshot[];
};

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readUtf8(path: string): string {
  try {
    return readFileSync(path).toString();
  } catch {
    fail("RUNNER_SQL_FILE_UNREADABLE");
  }
}

export function loadBundleSnapshot(): BundleSnapshot {
  const migrationsDirectory = resolve(__dirname, "../../../migrations");
  const bundleDirectory = resolve(
    migrationsDirectory,
    "pending/hrms-phase1",
  );
  const rootSql = readUtf8(resolve(migrationsDirectory, rootMigration.name));
  const files = bundleFileNames.map((name) => {
    const sql = readUtf8(resolve(bundleDirectory, name));
    return { name, sql, sha256: sha256(sql) };
  });
  const downFiles = bundleDownFileNames.map((name) => {
    const sql = readUtf8(resolve(bundleDirectory, name));
    return { name, sql, sha256: sha256(sql) };
  });
  return {
    root: {
      name: rootMigration.name,
      createdAt: rootMigration.createdAt,
      sha256: sha256(rootSql),
    },
    files,
    downFiles,
  };
}
