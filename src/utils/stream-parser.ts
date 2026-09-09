import { createReadStream } from "fs";
import { chain } from "stream-chain";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/Pick";
import { streamValues } from "stream-json/streamers/StreamValues";
import { PrismaClient } from "@prisma/client";
import { TrivyVulnerability } from "../types/trivy";
import { config } from "../config";

interface StreamedEntry {
  key: number;
  value: string | TrivyVulnerability;
}

type VulnInsert = {
  scanId: string;
  vulnerabilityId: string;
  pkgName: string;
  severity: string;
  title: string;
  installedVersion: string | null;
  fixedVersion: string | null;
  target: string;
};

function isTrivyVulnerability(v: unknown): v is TrivyVulnerability {
  return typeof v === "object" && v !== null && "VulnerabilityID" in v;
}

/**
 * Streams a Trivy JSON report and inserts only CRITICAL vulnerabilities
 * into the database in batches. Designed to handle 500MB+ files under
 * a 150MB heap limit.
 *
 * Strategy: a single-pass pipeline that picks BOTH Target strings and
 * individual Vulnerability objects from the token stream using one regex.
 * This ensures we never load a full Results[i] into memory (which could
 * itself be hundreds of MB), while still knowing which scan target each
 * vulnerability belongs to.
 *
 * The regex /^Results\.\d+\.(Target|Vulnerabilities\.\d+)$/ matches:
 *   - Results[i].Target        → a short string like "package-lock.json"
 *   - Results[i].Vulnerabilities[j] → one vulnerability object (~1-2KB)
 *
 * streamValues() then emits them in document order. Trivy's JSON always
 * places Target before Vulnerabilities in each Result (Go struct field
 * ordering), so we see the target string first, then its vulnerabilities.
 */
export async function extractCriticalVulnerabilities(
  filePath: string,
  scanId: string,
  prisma: PrismaClient
): Promise<number> {
  const pipeline = chain([
    createReadStream(filePath, { highWaterMark: config.scan.readStreamHighWaterMark }),
    parser(),
    pick({ filter: /^Results\.\d+\.(Target|Vulnerabilities\.\d+)$/ }),
    streamValues(),
  ]);

  const batch: VulnInsert[] = [];
  let totalInserted = 0;
  let currentTarget = "unknown";
  const batchSize = config.scan.batchSize;

  for await (const { value } of pipeline as AsyncIterable<StreamedEntry>) {
    if (typeof value === "string") {
      currentTarget = value;
      continue;
    }

    if (!isTrivyVulnerability(value) || value.Severity !== "CRITICAL") {
      continue;
    }

    batch.push({
      scanId,
      vulnerabilityId: value.VulnerabilityID,
      pkgName: value.PkgName,
      severity: value.Severity,
      title: value.Title || "No title",
      installedVersion: value.InstalledVersion || null,
      fixedVersion: value.FixedVersion || null,
      target: currentTarget,
    });

    if (batch.length >= batchSize) {
      totalInserted += batch.length;
      await prisma.vulnerability.createMany({ data: batch.splice(0) });
    }
  }

  if (batch.length > 0) {
    totalInserted += batch.length;
    await prisma.vulnerability.createMany({ data: batch.splice(0) });
  }

  return totalInserted;
}
