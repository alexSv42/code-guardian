# Code Guardian — Interview Walkthrough Guide

This document helps you explain every part of the solution to an interviewer. It covers what each file does, why each decision was made, what questions to expect, and how to answer them.

---

## Part 1: How to Present the Solution (Opening Pitch)

Start by saying something like:

> "I built a backend service called Code Guardian that wraps Trivy — an open-source vulnerability scanner. The main challenge was that the Trivy JSON output can be huge — over 500MB — and the Node.js app has to process it under a strict 150MB heap limit. So I couldn't just use `fs.readFile()` and `JSON.parse()` — I had to build a streaming pipeline that processes the file token by token, never loading more than a few KB into memory at a time.
>
> The API is non-blocking: you POST a repo URL, you get back a scan ID immediately, and the actual scanning happens in a background worker. You poll a GET endpoint to check status and get results. Everything runs in Docker — Postgres for storage, Redis for the job queue, Trivy as a separate server, and a React frontend."

Then walk them through the architecture diagram and the code file by file.

---

## Part 2: File-by-File Explanation

### `docker-compose.yml` — The Infrastructure

**What it does:** Defines 5 Docker containers that make up the system.

**How to explain it:**

> "Docker Compose orchestrates five services. Postgres stores scan metadata and vulnerabilities. Redis holds the BullMQ job queue — when someone submits a scan, the job goes into Redis and a worker picks it up. Trivy runs as a separate server — this is important because Trivy's vulnerability database is about 112MB, and if we loaded it inside our memory-constrained app container, we'd run out of memory before even starting to parse. So Trivy runs in its own container with unlimited memory, and our app talks to it as a lightweight client. The app container has a `mem_limit: 200m` — that's the Docker container limit, and inside it we set `--max-old-space-size=150` for the Node.js heap. The frontend is a React app served by Nginx, which also proxies API calls to the backend."

**Likely questions:**
- *"Why is Trivy a separate container?"* — Because Trivy's vuln DB is 112MB. If it ran inside the 200MB app container, there wouldn't be enough room for Node.js + the streaming pipeline. Separating it keeps the app container lean.
- *"Why `mem_limit: 200m` but `--max-old-space-size=150`?"* — The 200MB is the total container memory (includes Node.js runtime overhead, buffers, native allocations). The 150MB is just the V8 JavaScript heap. V8 needs the extra ~50MB for its own internal structures (stack, compiled code, GC metadata).
- *"What if Redis or Postgres goes down?"* — The `depends_on` with `condition: service_healthy` ensures the app only starts after they're healthy. If they crash during operation, BullMQ will retry stalled jobs when Redis comes back.

---

### `Dockerfile` — The Multi-Stage Build

**What it does:** Builds the app in two stages.

**How to explain it:**

> "It's a multi-stage Docker build. The first stage (builder) installs all dependencies including dev ones, generates the Prisma client, and compiles TypeScript to JavaScript. The second stage is the runtime — it starts from a clean `node:20-alpine`, installs only production dependencies plus `git` (needed for cloning repos) and the Trivy CLI (needed for running scans in client mode). It copies only the compiled `dist/` folder and the Prisma client from the builder — no TypeScript, no dev dependencies in the final image. The CMD runs Prisma migrations first, then starts Node.js with the 150MB heap limit."

**Likely questions:**
- *"Why multi-stage?"* — Keeps the runtime image small. Dev dependencies and TypeScript source aren't needed at runtime.
- *"Why `npm ci` instead of `npm install`?"* — `ci` installs exact versions from the lockfile — reproducible builds. `install` can modify the lockfile.
- *"Why install git in the runtime image?"* — Because the app spawns `git clone` as a child process to clone repos before scanning them. Without git, the clone step would fail.

---

### `prisma/schema.prisma` — The Database Schema

**What it does:** Defines two tables — `Scan` and `Vulnerability` — with a one-to-many relationship.

**How to explain it:**

> "The schema has two models. A `Scan` has an ID, a repo URL, a status enum (`Queued → Scanning → Finished → Failed`), and optional error text. A `Vulnerability` stores one CRITICAL finding — the CVE ID, package name, severity, installed and fixed versions, and which target file it came from. The relationship is one-to-many: one scan has many vulnerabilities. I used `onDelete: Cascade` so if a scan is deleted, all its vulnerabilities are automatically removed. There's an index on `scanId` in the Vulnerability table because the GET endpoint queries by that field."

**Likely questions:**
- *"Why Postgres and not SQLite or in-memory?"* — The task says to handle large reports. Hundreds of thousands of vulnerabilities in an in-memory Map would consume the heap we're trying to protect. Postgres keeps the data out of process memory entirely. SQLite would work too but Postgres is the industry standard.
- *"Why store vulnerabilities in the DB at all? Why not just return them from the stream?"* — Because the scan is asynchronous. The POST endpoint returns immediately — the scan happens in the background. When the GET endpoint is called (maybe hours later), the results need to be persisted somewhere. The DB is the answer.
- *"Why `onDelete: Cascade`?"* — If we delete a scan, we don't want orphaned vulnerability rows. Cascade makes the DB clean itself up.

---

### `src/config.ts` — Centralized Configuration

**What it does:** Reads all environment variables in one place with sensible defaults.

**How to explain it:**

> "All configuration is centralized here. Redis connection details, scan timeouts, batch size, and the Trivy server URL. The Trivy server URL is required — the app throws on startup if it's missing, because running without it would fail silently during the first scan. Everything else has defaults. This makes the code self-documenting — if you want to know what's configurable, you look at one file."

**Likely questions:**
- *"Why throw for missing `TRIVY_SERVER_URL`?"* — Fail-fast principle. Better to crash immediately on startup with a clear error than to accept scans that will all fail with a confusing 'connection refused' error later.
- *"What's `readStreamHighWaterMark`?"* — It controls the internal buffer size of `createReadStream`. Default is 64KB (65536 bytes). It determines how many bytes Node reads from disk in one syscall. Larger = fewer syscalls but more memory. 64KB is a good balance.
- *"What's `batchSize`?"* — How many vulnerabilities we accumulate before doing a bulk INSERT. Default is 100. Too small = too many DB round-trips. Too large = more memory used. 100 is a sweet spot.

---

### `src/index.ts` — The Entry Point

**What it does:** Starts Express and the BullMQ worker in the same Node.js process.

**How to explain it:**

> "This is the entry point. It does three things: connects to Postgres via Prisma, starts the BullMQ background worker, and starts the Express HTTP server. All three run in the same Node.js process. It also registers graceful shutdown handlers for SIGTERM and SIGINT — when Docker stops the container, it closes the HTTP server first (stops accepting new requests), then closes the worker (finishes current jobs), then disconnects from Postgres."

**Likely questions:**
- *"Why run the worker in the same process as the HTTP server? Shouldn't they be separate?"* — For this scale, it's simpler and sufficient. BullMQ's concurrency setting already limits parallel jobs. In production at scale, you'd separate them — run multiple worker instances independently. But for this task, one process keeps the deployment simple while still being non-blocking.
- *"Why graceful shutdown?"* — Without it, killing the container mid-scan would leave the DB in a dirty state (scan stuck at 'Scanning' forever). SIGTERM gives us a chance to finish the current job.

---

### `src/controllers/scan.controller.ts` — HTTP Handlers

**What it does:** Defines the two API endpoints.

**How to explain it:**

> "The controller handles HTTP only — validation, status codes, JSON responses. It doesn't contain business logic. The POST endpoint validates the repo URL using Zod. Zod checks that it's a valid URL AND matches a regex for GitHub/GitLab/Bitbucket. If validation fails, it returns a 400 with structured error details. If it passes, it calls the service layer. The GET endpoint validates that the scan ID looks like a UUID (regex check), then queries the service layer. If the scan doesn't exist, it returns 404."

**Likely questions:**
- *"Why Zod and not manual validation?"* — Zod gives type-safe validation with clear error messages for free. It also auto-narrows the type — after `safeParse`, `parsed.data.repoUrl` is guaranteed to be a valid string.
- *"Why validate the scanId format with regex?"* — Defense in depth. Without it, someone could pass a SQL-injection-like string as the scan ID. Although Prisma parameterizes queries (so SQL injection wouldn't work anyway), it's good practice to reject obviously invalid input early.
- *"Why `safeParse` instead of `parse`?"* — `parse` throws on invalid input. `safeParse` returns a result object with `success: boolean`. This lets us handle errors gracefully instead of relying on try-catch for validation logic.

---

### `src/services/scan.service.ts` — Business Logic

**What it does:** Creates scans and retrieves scan status.

**How to explain it:**

> "The service is the business logic layer. `createScan` does two things: creates a Scan record in Postgres with status 'Queued', then adds a job to the BullMQ Redis queue. The API returns the scan ID immediately — it doesn't wait for the scan to complete. `getScanStatus` queries Postgres for the scan. If the status is 'Finished', it also fetches the vulnerabilities. If it's still scanning, it returns an empty array — no point querying vulnerabilities that don't exist yet."

**Likely questions:**
- *"Why only load vulnerabilities for Finished scans?"* — Performance optimization. A Queued or Scanning scan has zero (or partial) vulnerabilities. Querying for them would be a wasted DB round-trip.
- *"What if the DB write succeeds but the queue add fails?"* — The scan would be stuck at 'Queued' forever. In production, you'd wrap this in a transaction or use an outbox pattern. For this task, the simplicity is acceptable.

---

### `src/workers/scan.worker.ts` — The Background Job

**What it does:** The actual scanning logic — clone, trivy, stream, cleanup.

**How to explain it:**

> "This is where the heavy lifting happens. When BullMQ picks up a job, this function runs. It creates a temp directory, then goes through four steps: 1) update the scan status to 'Scanning', 2) `git clone --depth 1` the repo into the temp dir, 3) run `trivy fs` in client mode pointing at the Trivy server, which writes the JSON results to a file, 4) run the streaming parser to extract CRITICAL vulnerabilities and insert them into Postgres in batches. If everything succeeds, it marks the scan as 'Finished'. If anything fails — clone timeout, Trivy error, stream error — the catch block deletes any partial vulnerabilities from the DB and marks the scan as 'Failed' with the error message. The finally block always cleans up the temp directory, even on failure."

**Likely questions:**
- *"Why `deleteMany` in the catch block?"* — If the stream parser fails midway after some batch inserts, there would be partial vulnerability data in the DB. We clean it up so the scan either has all results or none — no corrupt state.
- *"Why `finally` for cleanup?"* — `finally` runs whether the try block succeeds or the catch block runs. It guarantees temp files are always deleted, even if the catch block itself throws an error.
- *"What's concurrency: 2?"* — BullMQ processes up to 2 scan jobs simultaneously. This prevents resource exhaustion — each scan uses disk (for the clone), CPU (for Trivy), and DB connections. More than 2 parallel scans on a constrained container would be risky.
- *"Why `mkdtemp` and not a fixed directory?"* — Each scan gets its own unique temp directory. This prevents conflicts when multiple scans run in parallel — they can't step on each other's files.

---

### `src/utils/subprocess.ts` — Running External Commands

**What it does:** A helper that runs `git` and `trivy` as child processes with timeouts.

**How to explain it:**

> "Both git clone and trivy scan are external commands. This file has a shared helper `execWithTimeout` that spawns a child process, sets a timeout, and captures stderr for error reporting. It uses `spawn` with an args array, not `exec` with a shell string. The difference is security: `exec('git clone ' + url)` would let an attacker inject shell commands through a malicious URL. `spawn('git', ['clone', url])` passes the URL as a single argument — no shell interpretation, no injection. The timeout kills the process with SIGTERM if it runs too long. If the process is killed by a signal (which happens during OOM), we detect that and report it."

**Likely questions:**
- *"Why `spawn` and not `exec`?"* — `exec` runs through a shell (`/bin/sh -c`), which interprets special characters. A repo URL like `; rm -rf /` would be catastrophic. `spawn` bypasses the shell entirely — the URL is passed as a literal argument to git.
- *"Why capture stderr but not stdout?"* — Git and Trivy write progress to stderr and results to stdout/files. We only need stderr for error messages. Stdout is either not useful (git progress) or goes to a file (trivy `--output`).
- *"What if SIGTERM doesn't kill the process?"* — SIGTERM is a polite 'please exit.' Some processes ignore it. For robustness, you could follow up with SIGKILL after a grace period. In practice, both git and trivy respond to SIGTERM.

---

### `src/utils/stream-parser.ts` — The Core (Memory Challenge)

**What it does:** Parses a 500MB+ JSON file using under 64MB of heap.

**How to explain it:**

> "This is the hardest part of the project. The Trivy JSON file can be over 500MB, but our heap limit is 150MB. We can't use `fs.readFile()` or `JSON.parse()`. Instead, I use `stream-json` — a streaming JSON parser that works like SAX parsing in XML.
>
> The pipeline has four stages. First, `createReadStream` reads the file in 64KB chunks — the full file is never in memory. Second, `parser()` tokenizes the JSON on the fly — it emits events like 'start object', 'key', 'value', 'end object' without building a tree. Third, `pick()` with a regex filter selects only the paths we care about: `Results[i].Target` and `Results[i].Vulnerabilities[j]`. Everything else — the schema version, class, type, descriptions — is discarded at the token level. Fourth, `streamValues()` reassembles only the matched tokens back into JavaScript objects — but since we've already filtered, it only ever reconstructs one vulnerability object at a time, about 1-2KB.
>
> Then the `for await...of` loop reads values one at a time. If the value is a string, it's a Target name — I save it as `currentTarget`. If it's a vulnerability object with Severity 'CRITICAL', I add it to a batch array. When the batch hits 100 items, I do a bulk INSERT into Postgres and clear the array. This means at most 100 vulnerability objects are ever in memory at once.
>
> The `for await` loop also provides backpressure: when the DB insert is slow, the loop pauses, which pauses the stream, which pauses the file read. No data piles up.
>
> I tested this with a 500MB synthetic file. Peak heap was 63.7MB — well under the 150MB limit."

**Likely questions:**

- *"Why `chain()` and not Node.js `stream.pipeline()`?"*
  > "pipeline() connects streams and returns void — it's for fire-and-forget piping from source to sink. I need to read values in the middle of the pipeline (to check severity, batch them, write to DB), so I need a readable stream I can iterate over. `chain()` from `stream-chain` returns that."

- *"What does the regex `^Results\.\d+\.(Target|Vulnerabilities\.\d+)$` mean?"*
  > "It matches two path patterns in the JSON tree. `Results.0.Target` gives me the filename like 'package-lock.json'. `Results.0.Vulnerabilities.0` gives me one vulnerability object. The `\d+` matches the array indices. The `$` anchor means it won't match deeper paths like `Results.0.Vulnerabilities.0.PkgName` — I want the whole vulnerability object, not its individual fields."

- *"What if Target comes after Vulnerabilities in the JSON?"*
  > "Trivy serializes Go structs in field declaration order, and Target is declared before Vulnerabilities. But even if the order changed, the worst case is that vulnerabilities would get `currentTarget = 'unknown'` — no crash, no memory issue. The code is resilient to it."

- *"What's `batch.splice(0)`?"*
  > "It empties the array and returns the removed elements in one operation. It's like doing `const data = [...batch]; batch.length = 0; return data;` but in one call. I pass the spliced array directly to `createMany`."

- *"Why batch size 100 and not 1000?"*
  > "Trade-off between memory and DB round-trips. 100 vulnerability objects is roughly 100-200KB of heap — negligible. Going to 1000 would save some round-trips but use 10x the memory. At 100, the overhead is nearly zero and the DB writes are still efficient because Prisma's `createMany` generates a single INSERT statement."

- *"How do you know this actually works under memory pressure?"*
  > "I have a stress test script. It generates a synthetic 500MB Trivy JSON file with the correct structure, then runs the streaming parser with `--max-old-space-size=150`. The result: 500MB file, 151,190 CRITICAL vulnerabilities inserted, peak heap 63.7MB, completed in 19.3 seconds."

---

### Frontend — `frontend/src/App.tsx`

**What it does:** React app with polling.

**How to explain it:**

> "The frontend is straightforward React with TypeScript. You enter a repo URL, click Start Scan. It calls POST /api/scan, gets back a scanId, and starts polling GET /api/scan/:id every 2 seconds using `setInterval`. When the status becomes Finished or Failed, polling stops. The scan ID is automatically filled into a lookup field so you can also look up previous scans by ID. The results are displayed in a table with summary cards showing total CRITICAL count, affected targets, and affected packages."

**Likely questions:**
- *"Why polling and not WebSockets?"* — Polling is simpler and fits the task requirements. WebSockets would be better for real-time updates at scale, but for a scanner where scans take 30-120 seconds, polling every 2 seconds is perfectly adequate and much less code.
- *"Why `useRef` for the interval?"* — The interval ID needs to persist across renders without triggering re-renders. If I used `useState`, every `setInterval`/`clearInterval` would cause a re-render.

---

## Part 3: Common Cross-Cutting Questions

### "Walk me through what happens when I click Start Scan"

> 1. Frontend POSTs `{ repoUrl: "..." }` to `/api/scan`
> 2. Controller validates the URL with Zod
> 3. Service creates a Scan row in Postgres (status: Queued), adds a job to the Redis queue
> 4. API returns `{ scanId, status: "Queued" }` — the user isn't waiting
> 5. Frontend starts polling GET `/api/scan/:scanId` every 2 seconds
> 6. BullMQ worker picks up the job from Redis
> 7. Worker updates status to "Scanning" in Postgres
> 8. Worker spawns `git clone --depth 1` into a temp directory
> 9. Worker spawns `trivy fs --server <url>` which writes results.json
> 10. Worker runs the streaming parser: reads results.json in 64KB chunks, tokenizes, filters to CRITICAL vulnerabilities, batch-inserts into Postgres
> 11. Worker updates status to "Finished"
> 12. Worker deletes the temp directory (clone + JSON file)
> 13. Next frontend poll sees "Finished", stops polling, displays results

### "What happens if the scan fails?"

> The catch block in the worker: deletes any partially-inserted vulnerabilities (in case the stream parser failed midway), updates the scan status to "Failed" with the error message. The finally block always cleans up temp files. The frontend will see "Failed" status and display the error message.

### "What if the server crashes during a scan?"

> BullMQ tracks job state in Redis. If a worker crashes, the job becomes "stalled". When the server restarts, BullMQ detects the stalled job and re-queues it. The scan will re-run from scratch.

### "How do you prevent command injection?"

> Two layers: 1) Zod validation ensures the URL matches a whitelist regex (GitHub/GitLab/Bitbucket format). 2) `child_process.spawn` with an args array never passes through a shell — there's no string interpolation where special characters could be interpreted.

### "Could this handle 10,000 concurrent scan requests?"

> The API would accept them all instantly — each POST just writes to Postgres and Redis, which takes milliseconds. The bottleneck is the worker concurrency (currently 2). Jobs would queue up in Redis. To scale: run multiple worker containers, each processing 2-3 scans in parallel. BullMQ handles distributed consumers out of the box.

### "Why not use a message broker like RabbitMQ instead of Redis?"

> Redis + BullMQ gives us a job queue, retry logic, and concurrency control with minimal infrastructure. RabbitMQ would add another service to manage. For this use case — where jobs are created and consumed by the same application — BullMQ on top of the Redis we already need is the simpler choice.

### "Why Express and not Fastify/Koa/Hapi?"

> Express is the most widely known Node.js framework. For two endpoints with JSON bodies, there's no meaningful performance difference between frameworks. Express's familiarity reduces cognitive overhead for anyone reviewing the code.

---

## Part 4: The Numbers to Remember

| Metric | Value |
|--------|-------|
| Stress test file size | 500MB |
| Heap limit | 150MB |
| Peak heap during stress test | 63.7MB |
| CRITICAL vulns inserted | 151,190 |
| Stress test duration | 19.3 seconds |
| Docker container memory limit | 200MB |
| Trivy vuln DB size | ~112MB |
| Stream read buffer size | 64KB |
| DB batch size | 100 |
| Poll interval | 2 seconds |
| Worker concurrency | 2 |

---

## Part 5: What Makes This Solution Good

When summarizing, emphasize these points:

1. **Memory discipline** — The entire codebase is designed so that no single function ever holds more than a few KB of scan data in memory. The streaming pipeline, the batch inserts, the database storage — every piece supports this.

2. **Clean separation of concerns** — Controller (HTTP + validation), Service (business logic + queue), Worker (orchestration), Utils (subprocess + streaming). Each file does one thing.

3. **Production habits** — Graceful shutdown, error cleanup, input validation, timeout on external processes, health endpoint, configurable via environment variables.

4. **Testable claim** — The 500MB stress test isn't theoretical. The scripts are in the repo. Anyone can run them and see the same numbers.

5. **Trivy client-server split** — A subtle but important decision. Running Trivy inside the memory-constrained container would have failed. Splitting it out shows understanding of how memory limits actually work in Docker.
