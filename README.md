# Code Guardian

A backend service that wraps [Trivy](https://trivy.dev/) to scan Git repositories for security vulnerabilities. The twist: it handles **huge** Trivy reports (500MB+) without crashing, even when the Node.js heap is capped at 150MB.

You give it a repo URL, it clones the repo, runs Trivy, streams the results through a memory-efficient pipeline, and stores only the CRITICAL vulnerabilities in PostgreSQL. Everything runs in Docker.

## How It Works (the short version)

1. You `POST /api/scan` with a repo URL. The API returns immediately with a `scanId` and status `Queued`.
2. A background worker picks up the job from a Redis-backed queue.
3. The worker clones the repo, runs Trivy, and streams the JSON output object-by-object (never loading it all into memory).
4. Only CRITICAL vulnerabilities get inserted into PostgreSQL in batches.
5. You poll `GET /api/scan/:scanId` to check progress and get results when it's done.

There's also a React frontend that does the polling automatically every 2 seconds and displays the results in a table.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Docker Compose                               │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌───────────────┐    ┌──────────┐ │
│  │ Frontend │───▶│   App    │───▶│    Redis      │    │ Postgres │ │
│  │ (React)  │    │ (Express)│◀───│   (BullMQ)    │    │          │ │
│  │ port 80  │    │ port 3000│    │   port 6379   │    │ port 5432│ │
│  └──────────┘    └────┬─────┘    └───────────────┘    └────▲─────┘ │
│    Nginx proxy        │                                    │       │
│    /api/* ──▶ app     │                                    │       │
│                       │         ┌───────────────┐          │       │
│                       └────────▶│ Trivy Server  │          │       │
│                        client   │  port 4954    │          │       │
│                        mode     │ (holds vuln   │          │       │
│                                 │  database)    │          │       │
│                                 └───────────────┘          │       │
│                                                            │       │
│  App container (200MB memory limit, 150MB Node.js heap):   │       │
│  ┌──────────────────────────────────────────────────────┐  │       │
│  │                                                      │  │       │
│  │  Controller ──▶ Service ──▶ BullMQ Queue             │  │       │
│  │      │              │           │                    │  │       │
│  │      │         Prisma ORM       ▼                    │  │       │
│  │      │              │       Worker                   │  │       │
│  │      │              │     ┌─────────────────┐        │  │       │
│  │      │              │     │ 1. git clone    │        │  │       │
│  │      │              │     │ 2. trivy scan   │        │  │       │
│  │      │              │     │ 3. stream parse │        │  │       │
│  │      │              │     │ 4. batch INSERT │────────┘  │       │
│  │      │              │     │ 5. cleanup      │           │       │
│  │      │              │     └─────────────────┘           │       │
│  │      │              │                                   │       │
│  └──────┴──────────────┴───────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

### The Streaming Pipeline (how we survive 500MB+ reports)

This is the core of the project. Instead of loading the entire Trivy JSON into memory, we use `stream-json` to process it token by token:

```
results.json ──▶ createReadStream (64KB chunks)
                    │
                    ▼
                 parser()          ← SAX-style JSON tokenizer, never holds full DOM
                    │
                    ▼
                 pick(regex)       ← filters to only Results[i].Target and
                    │                 Results[i].Vulnerabilities[j]
                    ▼
                 streamValues()    ← reassembles just the matched leaf values (~1-2KB each)
                    │
                    ▼
                 for await...of    ← processes one value at a time:
                    │                 - if it's a string → update currentTarget
                    │                 - if it's a vuln with Severity=CRITICAL → add to batch
                    │                 - when batch is full → INSERT into Postgres, clear batch
                    ▼
                 Postgres          ← only CRITICAL vulnerabilities are stored
```

The `pick` regex `^Results\.\d+\.(Target|Vulnerabilities\.\d+)$` is key — it tells `stream-json` to only reassemble these specific paths in the JSON tree. Everything else is discarded as soon as it's tokenized. This means even if a single `Results[i]` entry is 100MB (thousands of vulnerabilities for one target), we never hold more than one vulnerability object in memory at a time.

The `for await...of` loop also handles backpressure automatically — if the database insert is slow, the stream pauses and waits, preventing memory from growing.

### Why Trivy Runs as a Separate Server

Trivy's vulnerability database is ~112MB. If we loaded it inside the memory-constrained app container (200MB limit), there wouldn't be enough room for Node.js + the streaming pipeline. So Trivy runs as its own Docker service in server mode, and our app calls it as a lightweight client. The client just sends the scan path and receives the output — no database in memory.

### Why BullMQ + Redis

Scanning is slow (clone + trivy can take minutes). The API needs to respond immediately. BullMQ gives us:

- A Redis-backed queue — jobs survive server restarts
- Configurable concurrency — prevents the server from being overwhelmed by parallel scans
- Status tracking — `Queued → Scanning → Finished / Failed`

### Why PostgreSQL (via Prisma ORM)

We can't hold vulnerabilities in application memory (that would defeat the purpose of streaming). PostgreSQL stores:

- Scan metadata (status, timestamps, errors)
- CRITICAL vulnerabilities (with the target file they came from)

The GET endpoint queries Postgres directly — zero in-memory accumulation.

## What You Need

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose (that's it — everything else runs in containers)

For local development without Docker:
- Node.js 20+
- PostgreSQL
- Redis
- Trivy CLI
- Git

## Getting Started

### With Docker (recommended)

```bash
git clone <repo-url> && cd code-guardian

docker compose up --build
```

This starts 5 containers:

| Container | What it does | Port |
|-----------|-------------|------|
| `postgres` | Stores scans and vulnerabilities | 5434 (mapped from 5432) |
| `redis` | Job queue for BullMQ | 6380 (mapped from 6379) |
| `trivy` | Vulnerability scanner in server mode | 4954 |
| `app` | Node.js backend (200MB memory limit) | 3000 |
| `frontend` | React UI served by Nginx | 8081 |

Once everything is up, open [http://localhost:8081](http://localhost:8081) in your browser.

### Local Development (without Docker for the app)

You still need Postgres, Redis, and Trivy running. The easiest way is to start just those services:

```bash
# Start infrastructure
docker compose up postgres redis trivy -d

# Install dependencies
npm install

# Set up environment
cp .env.example .env

# Run database migrations
npx prisma migrate dev --name init

# Start the dev server
npm run dev
```

The app will be available at [http://localhost:3000](http://localhost:3000).

## API Endpoints

### Start a Scan

```bash
curl -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"repoUrl": "https://github.com/OWASP/NodeGoat"}'
```

**Response (201):**
```json
{
  "scanId": "a1b2c3d4-e5f6-...",
  "status": "Queued"
}
```

The API validates the URL with Zod — it must be a valid GitHub, GitLab, or Bitbucket URL.

### Check Status / Get Results

```bash
curl http://localhost:3000/api/scan/<scanId>
```

**While scanning:**
```json
{
  "scanId": "a1b2c3d4-...",
  "status": "Scanning",
  "vulnerabilities": []
}
```

**When finished:**
```json
{
  "scanId": "a1b2c3d4-...",
  "status": "Finished",
  "vulnerabilities": [
    {
      "vulnerabilityId": "CVE-2023-...",
      "pkgName": "lodash",
      "severity": "CRITICAL",
      "title": "Prototype Pollution",
      "installedVersion": "4.17.11",
      "fixedVersion": "4.17.21",
      "target": "package-lock.json"
    }
  ]
}
```

### Health Check

```bash
curl http://localhost:3000/health
```

## Frontend

A React + TypeScript single-page app. It takes a repo URL, submits a scan, and polls the status endpoint every 2 seconds until the scan finishes or fails. Results are displayed in a table with summary cards.

For local frontend development:

```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:5173 — proxies API calls to localhost:3000
```

## Project Structure

```
code-guardian/
├── docker-compose.yml          # All 5 services defined here
├── Dockerfile                  # Multi-stage build for the app
├── package.json
├── tsconfig.json
├── prisma/
│   └── schema.prisma           # Database schema (Scan + Vulnerability tables)
│
├── src/
│   ├── index.ts                # Express server + BullMQ worker startup + graceful shutdown
│   ├── config.ts               # All environment variables in one place
│   │
│   ├── controllers/
│   │   └── scan.controller.ts  # HTTP handlers — validates input, returns JSON
│   │
│   ├── services/
│   │   └── scan.service.ts     # Business logic — creates scans, enqueues jobs, queries results
│   │
│   ├── workers/
│   │   └── scan.worker.ts      # Background job — clone → trivy → stream → cleanup
│   │
│   ├── utils/
│   │   ├── subprocess.ts       # Runs git and trivy as child processes with timeouts
│   │   ├── stream-parser.ts    # The streaming JSON pipeline (the memory-critical part)
│   │   └── prisma.ts           # Prisma client singleton
│   │
│   └── types/
│       ├── trivy.ts            # TypeScript interface for Trivy vulnerability objects
│       └── stream-json.d.ts    # Type declarations for stream-json / stream-chain
│
└── frontend/
    ├── Dockerfile              # Builds React app, serves with Nginx
    ├── nginx.conf              # Proxies /api/* to the backend
    ├── src/
    │   ├── App.tsx             # Main component — form, polling, results table
    │   ├── types.ts            # Frontend TypeScript types
    │   └── main.tsx            # React entry point
    └── public/
        └── ox-logo.png         # OX Security logo
```

## Dependencies

### Backend

| Package | Why |
|---------|-----|
| `express` | HTTP server |
| `bullmq` + `ioredis` | Redis-backed job queue for background scan processing |
| `@prisma/client` + `prisma` | ORM for PostgreSQL — type-safe queries, migrations |
| `stream-json` + `stream-chain` | Streaming JSON parser — processes files token-by-token without loading into memory |
| `zod` | Input validation (repo URL format) |
| `cors` | Cross-origin requests from the frontend |

### Frontend

| Package | Why |
|---------|-----|
| `react` + `react-dom` | UI framework |
| `vite` | Dev server and build tool |
| `typescript` | Type safety |

### Infrastructure (Docker images)

| Image | Why |
|-------|-----|
| `node:20-alpine` | App runtime |
| `postgres:16-alpine` | Database |
| `redis:7-alpine` | Queue storage |
| `aquasec/trivy:latest` | Vulnerability scanner (runs as server) |
| `nginx:alpine` | Serves frontend, proxies API calls |

## How Git Clone Works

The app container has `git` installed (`apk add git` in the Dockerfile). When a scan job runs, it spawns `git clone --depth 1 <url> <tmpdir>` as a child process using Node.js `child_process.spawn`. We use `spawn` with an args array (not `exec` with a shell string) to prevent command injection. The `--depth 1` flag creates a shallow clone to save disk and time.

Both `git clone` and `trivy scan` have configurable timeouts (default: 2 minutes for clone, 5 minutes for trivy). If they exceed the timeout, the process is killed with `SIGTERM`.

## Error Handling and Cleanup

| What can go wrong | What happens |
|---|---|
| Invalid repo URL | 400 response with Zod validation errors |
| Git clone fails (bad URL, timeout, auth) | Scan → `Failed`, error message stored in DB |
| Trivy fails or times out | Scan → `Failed`, error message stored in DB |
| Stream parser fails mid-way | Partially inserted vulnerabilities are deleted from DB, scan → `Failed` |
| Server restarts during a scan | BullMQ recovers stalled jobs from Redis |
| Temp files left behind | `finally` block always runs `rm -rf` on the temp directory, even on failure |

## Memory Verification

To prove the streaming works under memory pressure:

```bash
# With Docker (already constrained to 200MB container / 150MB heap)
docker compose up --build

# Locally
npm run build
node --max-old-space-size=150 dist/index.js
```

If the code used `fs.readFile()` or `JSON.parse()` on the full Trivy output, it would crash with an out-of-memory error. With the streaming pipeline, it runs smoothly regardless of report size.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `TRIVY_SERVER_URL` | — (required) | URL of the Trivy server (e.g. `http://trivy:4954`) |
| `PORT` | `3000` | Express server port |
| `SCAN_CONCURRENCY` | `2` | Max parallel scan jobs |
| `CLONE_TIMEOUT_MS` | `120000` | Git clone timeout (ms) |
| `TRIVY_TIMEOUT_MS` | `300000` | Trivy scan timeout (ms) |
| `BATCH_SIZE` | `100` | DB insert batch size |
| `READ_STREAM_HWM` | `65536` | Read stream buffer size (bytes) |
