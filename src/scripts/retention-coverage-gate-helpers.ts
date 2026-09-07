import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export const BACKEND_ROOT = resolve(__dirname, "../..");
export const GATE = resolve(BACKEND_ROOT, "src/scripts/check-retention-coverage.mjs");

export interface GateRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runGate(args: readonly string[], env: NodeJS.ProcessEnv): GateRun {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], {
      cwd: BACKEND_ROOT,
      encoding: "utf8",
      env: { ...env, NODE_OPTIONS: "--max-old-space-size=1024" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
