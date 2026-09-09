import express from "express";
import cors from "cors";
import { config } from "./config";
import { scanRouter } from "./controllers/scan.controller";
import { createScanWorker } from "./workers/scan.worker";
import { prisma } from "./utils/prisma";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/scan", scanRouter);

async function main() {
  await prisma.$connect();
  console.log("Connected to database");

  const worker = createScanWorker();
  console.log(`Scan worker started (concurrency: ${config.scan.concurrency})`);

  const server = app.listen(config.port, () => {
    console.log(`Code Guardian listening on port ${config.port}`);
  });

  async function shutdown() {
    console.log("Shutting down...");
    server.close();
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
