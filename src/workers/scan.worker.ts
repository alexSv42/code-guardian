import { Worker, Job } from "bullmq";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtemp, rm } from "fs/promises";
import { config } from "../config";
import { prisma } from "../utils/prisma";
import { gitClone, runTrivy } from "../utils/subprocess";
import { extractCriticalVulnerabilities } from "../utils/stream-parser";

interface ScanJobData {
  scanId: string;
  repoUrl: string;
}

async function processScanJob(job: Job<ScanJobData>): Promise<void> {
  const { scanId, repoUrl } = job.data;
  const tmpDir = await mkdtemp(join(tmpdir(), "code-guardian-"));

  try {
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: "Scanning" },
    });

    const repoDir = join(tmpDir, "repo");
    await gitClone(repoUrl, repoDir, config.scan.cloneTimeoutMs);

    const outputPath = join(tmpDir, "results.json");
    await runTrivy(repoDir, outputPath, config.scan.trivyServerUrl, config.scan.trivyTimeoutMs);

    const count = await extractCriticalVulnerabilities(outputPath, scanId, prisma);

    await prisma.scan.update({
      where: { id: scanId },
      data: { status: "Finished" },
    });

    console.log(`Scan ${scanId} finished: ${count} critical vulnerabilities found`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Scan ${scanId} failed: ${message}`);

    await prisma.vulnerability.deleteMany({ where: { scanId } });
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: "Failed", error: message },
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch((err) => {
      console.error(`Failed to cleanup ${tmpDir}: ${err.message}`);
    });
  }
}

export function createScanWorker(): Worker<ScanJobData> {
  const worker = new Worker<ScanJobData>(config.queueName, processScanJob, {
    connection: config.redis,
    concurrency: config.scan.concurrency,
  });

  worker.on("failed", (job, err) => {
    console.error(`Job ${job?.id} failed:`, err.message);
  });

  worker.on("error", (err) => {
    console.error("Worker error:", err.message);
  });

  return worker;
}
