import { Queue } from "bullmq";
import { prisma } from "../utils/prisma";
import { config } from "../config";

const scanQueue = new Queue(config.queueName, {
  connection: config.redis,
});

export interface CreateScanResult {
  scanId: string;
  status: string;
}

export interface VulnerabilityResult {
  vulnerabilityId: string;
  pkgName: string;
  severity: string;
  title: string;
  installedVersion: string | null;
  fixedVersion: string | null;
  target: string;
}

export interface ScanStatusResult {
  scanId: string;
  status: string;
  error?: string;
  vulnerabilities: VulnerabilityResult[];
}

export async function createScan(repoUrl: string): Promise<CreateScanResult> {
  const scan = await prisma.scan.create({
    data: { repoUrl },
  });

  await scanQueue.add("scan", {
    scanId: scan.id,
    repoUrl,
  });

  return { scanId: scan.id, status: scan.status };
}

export async function getScanStatus(scanId: string): Promise<ScanStatusResult | null> {
  const scan = await prisma.scan.findUnique({
    where: { id: scanId },
  });

  if (!scan) {
    return null;
  }

  const vulnerabilities: VulnerabilityResult[] =
    scan.status === "Finished"
      ? await prisma.vulnerability.findMany({
          where: { scanId },
          select: {
            vulnerabilityId: true,
            pkgName: true,
            severity: true,
            title: true,
            installedVersion: true,
            fixedVersion: true,
            target: true,
          },
        })
      : [];

  return {
    scanId: scan.id,
    status: scan.status,
    ...(scan.error && { error: scan.error }),
    vulnerabilities,
  };
}
