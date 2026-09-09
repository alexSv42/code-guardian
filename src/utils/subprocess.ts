import { spawn } from "child_process";

interface ExecOptions {
  command: string;
  args: string[];
  timeoutMs: number;
  label: string;
}

/**
 * Spawns a child process with a timeout. Returns a promise that resolves
 * on exit code 0 and rejects on failure, signal kill, or timeout.
 *
 * Uses spawn with an args array (not exec with a shell string) to
 * prevent command injection.
 */
function execWithTimeout({ command, args, timeoutMs, label }: ExecOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else if (signal) {
        reject(new Error(`${label} killed by signal ${signal} (likely OOM)`));
      } else {
        reject(new Error(`${label} failed (exit ${code}): ${stderr.trim()}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`${label} spawn error: ${err.message}`));
    });
  });
}

export function gitClone(repoUrl: string, targetDir: string, timeoutMs: number): Promise<void> {
  return execWithTimeout({
    command: "git",
    args: ["clone", "--depth", "1", repoUrl, targetDir],
    timeoutMs,
    label: "git clone",
  });
}

export function runTrivy(scanDir: string, outputPath: string, serverUrl: string, timeoutMs: number): Promise<void> {
  return execWithTimeout({
    command: "trivy",
    args: ["fs", "--format", "json", "--output", outputPath, "--server", serverUrl, scanDir],
    timeoutMs,
    label: "trivy scan",
  });
}
