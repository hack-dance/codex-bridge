import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";

describe("bridge e2e smoke", () => {
  it("runs complete lane/session/webhook path", async () => {
    const proc = spawn("bun", ["run", "scripts/e2e-smoke.ts"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, E2E_DEBUG: "1" },
    });

    const stdout: string[] = [];
    const stderr: string[] = [];

    proc.stdout?.on("data", (chunk) => {
      stdout.push(chunk.toString());
    });
    proc.stderr?.on("data", (chunk) => {
      stderr.push(chunk.toString());
    });

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("exit", (code) => {
        resolve(code ?? 1);
      });
    });

    expect(exitCode).toBe(0);
    const output = stdout.join("") + stderr.join("");
    expect(output).toContain("start-visible-workflow-completed");
  });
});
