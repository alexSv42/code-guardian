if (!process.env.TRIVY_SERVER_URL) {
  throw new Error("TRIVY_SERVER_URL environment variable is required");
}

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
  },
  scan: {
    concurrency: parseInt(process.env.SCAN_CONCURRENCY || "2", 10),
    cloneTimeoutMs: parseInt(process.env.CLONE_TIMEOUT_MS || "120000", 10),
    trivyTimeoutMs: parseInt(process.env.TRIVY_TIMEOUT_MS || "300000", 10),
    trivyServerUrl: process.env.TRIVY_SERVER_URL,
    batchSize: parseInt(process.env.BATCH_SIZE || "100", 10),
    readStreamHighWaterMark: parseInt(process.env.READ_STREAM_HWM || "65536", 10),
  },
  queueName: "scan-queue",
} as const;
