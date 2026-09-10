/**
 * Stress test: runs the streaming parser against a large Trivy JSON file
 * and measures memory usage throughout.
 *
 * This proves the stream pipeline works under the 150MB heap limit.
 * It writes to a real Postgres DB (uses DATABASE_URL from .env).
 *
 * Usage:
 *   node --max-old-space-size=150 -r tsx/cjs scripts/stress-test.ts [reportPath]
 *
 * Or after build:
 *   node --max-old-space-size=150 dist/scripts/stress-test.js [reportPath]
 */

import { PrismaClient } from "@prisma/client";
import { extractCriticalVulnerabilities } from "../src/utils/stream-parser";
import { stat } from "fs/promises";

const REPORT_PATH = process.argv[2] || "/tmp/huge-trivy-report.json";

function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

async function main() {
  const fileInfo = await stat(REPORT_PATH);
  const fileSizeMB = (fileInfo.size / 1024 / 1024).toFixed(1);
  console.log(`\nReport file: ${REPORT_PATH} (${fileSizeMB}MB)`);

  const heapLimit = require("v8").getHeapStatistics().heap_size_limit;
  console.log(`Heap limit: ${formatMB(heapLimit)}`);
  console.log(`─`.repeat(50));

  const prisma = new PrismaClient();
  await prisma.$connect();

  const scan = await prisma.scan.create({
    data: { repoUrl: "stress-test://synthetic-500mb", status: "Scanning" },
  });

  console.log(`\nScan ID: ${scan.id}`);
  console.log(`Starting streaming parse...\n`);

  const memInterval = setInterval(() => {
    const mem = process.memoryUsage();
    process.stdout.write(
      `  heap: ${formatMB(mem.heapUsed)} / ${formatMB(mem.heapTotal)}` +
      `  rss: ${formatMB(mem.rss)}\r`
    );
  }, 500);

  const startTime = Date.now();
  let peakHeap = 0;
  const peakInterval = setInterval(() => {
    const heap = process.memoryUsage().heapUsed;
    if (heap > peakHeap) peakHeap = heap;
  }, 100);

  try {
    const count = await extractCriticalVulnerabilities(REPORT_PATH, scan.id, prisma);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    clearInterval(memInterval);
    clearInterval(peakInterval);

    await prisma.scan.update({
      where: { id: scan.id },
      data: { status: "Finished" },
    });

    const finalMem = process.memoryUsage();

    console.log(`\n\n${"═".repeat(50)}`);
    console.log(`  STRESS TEST PASSED`);
    console.log(`${"═".repeat(50)}`);
    console.log(`  File size:          ${fileSizeMB}MB`);
    console.log(`  Heap limit:         ${formatMB(heapLimit)}`);
    console.log(`  Peak heap used:     ${formatMB(peakHeap)}`);
    console.log(`  Final heap used:    ${formatMB(finalMem.heapUsed)}`);
    console.log(`  Final RSS:          ${formatMB(finalMem.rss)}`);
    console.log(`  CRITICALs inserted: ${count}`);
    console.log(`  Time:               ${elapsed}s`);
    console.log(`${"═".repeat(50)}\n`);

    await prisma.vulnerability.deleteMany({ where: { scanId: scan.id } });
    await prisma.scan.delete({ where: { id: scan.id } });
    console.log("Cleaned up test data from DB.");
  } catch (err) {
    clearInterval(memInterval);
    clearInterval(peakInterval);
    await prisma.vulnerability.deleteMany({ where: { scanId: scan.id } });
    await prisma.scan.delete({ where: { id: scan.id } });
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("\nSTRESS TEST FAILED:", err.message);
  process.exit(1);
});
