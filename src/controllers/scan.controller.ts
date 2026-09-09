import { Router, Request, Response } from "express";
import { z } from "zod";
import { createScan, getScanStatus } from "../services/scan.service";

const repoUrlSchema = z.object({
  repoUrl: z
    .string()
    .url("Must be a valid URL")
    .regex(
      /^https:\/\/(github|gitlab|bitbucket)\.\w+\/.+\/.+/,
      "Must be a GitHub, GitLab, or Bitbucket repository URL"
    ),
});

export const scanRouter = Router();

scanRouter.post("/", async (req: Request, res: Response) => {
  const parsed = repoUrlSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const result = await createScan(parsed.data.repoUrl);
    res.status(201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to create scan:", message);
    res.status(500).json({ error: "Failed to create scan" });
  }
});

scanRouter.get("/:scanId", async (req: Request<{ scanId: string }>, res: Response) => {
  const scanId = req.params.scanId;

  if (!/^[0-9a-f-]{36}$/.test(scanId)) {
    res.status(400).json({ error: "Invalid scan ID format" });
    return;
  }

  try {
    const result = await getScanStatus(scanId);

    if (!result) {
      res.status(404).json({ error: "Scan not found" });
      return;
    }

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to get scan status:", message);
    res.status(500).json({ error: "Failed to get scan status" });
  }
});
