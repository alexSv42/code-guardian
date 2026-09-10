/**
 * Generates a synthetic Trivy JSON report of a target size (default 500MB+).
 * The output has the exact same structure as real Trivy output so the
 * streaming parser can process it unchanged.
 *
 * Usage:
 *   npx tsx scripts/generate-huge-report.ts [sizeMB] [outputPath]
 *
 * Example:
 *   npx tsx scripts/generate-huge-report.ts 500 /tmp/huge-report.json
 */

import { createWriteStream } from "fs";
import { finished } from "stream/promises";

const TARGET_MB = parseInt(process.argv[2] || "500", 10);
const OUTPUT_PATH = process.argv[3] || "/tmp/huge-trivy-report.json";
const TARGET_BYTES = TARGET_MB * 1024 * 1024;

const TARGETS = [
  "package-lock.json",
  "yarn.lock",
  "go.mod",
  "requirements.txt",
  "Gemfile.lock",
  "pom.xml",
  "Dockerfile",
  "composer.lock",
];

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
const PACKAGES = [
  "lodash", "express", "minimist", "axios", "underscore",
  "moment", "debug", "chalk", "commander", "semver",
  "glob", "rimraf", "mkdirp", "async", "request",
  "bluebird", "uuid", "yargs", "inquirer", "webpack",
];

function randomItem<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomVersion(): string {
  return `${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 20)}.${Math.floor(Math.random() * 30)}`;
}

function makeVulnerability(): string {
  const year = 2018 + Math.floor(Math.random() * 8);
  const id = 10000 + Math.floor(Math.random() * 90000);
  return JSON.stringify({
    VulnerabilityID: `CVE-${year}-${id}`,
    PkgName: randomItem(PACKAGES),
    InstalledVersion: randomVersion(),
    FixedVersion: Math.random() > 0.3 ? randomVersion() : "",
    Severity: randomItem(SEVERITIES),
    Title: `Synthetic vulnerability CVE-${year}-${id} for stress testing the streaming parser under memory constraints`,
    Description: "This is a synthetic vulnerability generated for stress testing. ".repeat(5),
    References: [
      `https://nvd.nist.gov/vuln/detail/CVE-${year}-${id}`,
      `https://github.com/advisories/GHSA-xxxx-xxxx-xxxx`,
    ],
  });
}

async function generate() {
  const ws = createWriteStream(OUTPUT_PATH);
  let bytesWritten = 0;

  function write(s: string): boolean {
    bytesWritten += Buffer.byteLength(s);
    return ws.write(s);
  }

  async function drain() {
    await new Promise<void>((resolve) => ws.once("drain", resolve));
  }

  write('{"SchemaVersion":2,"Results":[');

  let firstResult = true;

  for (const target of TARGETS) {
    if (bytesWritten >= TARGET_BYTES) break;

    if (!firstResult) write(",");
    firstResult = false;

    write(`{"Target":"${target}","Class":"lang-pkgs","Type":"npm","Vulnerabilities":[`);

    let firstVuln = true;
    while (bytesWritten < TARGET_BYTES / TARGETS.length * (TARGETS.indexOf(target) + 1)) {
      if (!firstVuln) write(",");
      firstVuln = false;

      const ok = write(makeVulnerability());
      if (!ok) await drain();
    }

    write("]}");

    const pct = ((bytesWritten / TARGET_BYTES) * 100).toFixed(1);
    const mb = (bytesWritten / 1024 / 1024).toFixed(1);
    process.stderr.write(`\r  ${target}: ${mb}MB written (${pct}%)`);
  }

  write("]}");
  ws.end();
  await finished(ws);

  const finalMB = (bytesWritten / 1024 / 1024).toFixed(1);
  console.error(`\n\nGenerated ${finalMB}MB report at ${OUTPUT_PATH}`);
}

generate().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
