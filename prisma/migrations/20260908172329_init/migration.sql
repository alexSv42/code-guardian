-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('Queued', 'Scanning', 'Finished', 'Failed');

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'Queued',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vulnerability" (
    "id" SERIAL NOT NULL,
    "scanId" TEXT NOT NULL,
    "vulnerabilityId" TEXT NOT NULL,
    "pkgName" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "installedVersion" TEXT,
    "fixedVersion" TEXT,
    "target" TEXT NOT NULL,

    CONSTRAINT "Vulnerability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vulnerability_scanId_idx" ON "Vulnerability"("scanId");

-- AddForeignKey
ALTER TABLE "Vulnerability" ADD CONSTRAINT "Vulnerability_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
