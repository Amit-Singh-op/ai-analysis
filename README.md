# Local AI Data Analyst — Local-First Telemetry Analytics

A local-first, privacy-preserving proof-of-concept for natural language analytics over device telemetry and shipment consignments.

This system combines a local open-weight model (**Meta Llama 3.2 3B Instruct** running via **Ollama**) with a local **PostgreSQL** database. The language model acts exclusively as an analytical translator and explainer: it selects approved deterministic analytics tools, while all queries and computations are strictly executed by parameterized SQL functions with least-privilege read-only permissions.

> **Zero Hallucination / Zero Paid API Policy:**
> - No external AI API calls (OpenAI, Anthropic, AWS, etc.).
> - No model-generated arbitrary SQL allowed.
> - The application database role has strictly enforced `SELECT`-only permissions.
> - Facts and numbers are deterministically retrieved and cited directly from tool execution outputs.

---

## Architecture Overview

```
  Chat UI (http://127.0.0.1:3000)
        │  question + what the previous answer was about
        ▼
  Local LLM planner (Ollama)          src/ai/planner.ts
        │  JSON query plan: what to measure, how to group, which filters
        ▼
  Query builder                       src/analytics/query-builder.ts
        │  parameterized, read-only SQL (identifiers whitelisted, values bound)
        ▼
  PostgreSQL (analyst_user, SELECT-only)
        │  rows
        ▼
  Answer written from the rows        src/ai/plan-answer.ts, src/ai/reports.ts
```

The model decides **what** to look up; it never writes SQL or numbers. Every number in an answer comes from the database. Mistakes are corrected with **Not right?** in the chat (or `npm run fix`), and the model learns from the saved corrections.

---

## Tenant isolation

Each client sees only its own data, enforced in Postgres ([database/tenancy.sql](database/tenancy.sql)), never by the model:

- A client owns **consignments** (`consignments.client_id`). It sees a device's readings and events only while the device is on one of its consignments.
- The app connects as **`analyst_ro`**, which can only read the `v_*` views, read-only, with a statement timeout.
- Every query runs in a transaction with `app.client_id` set from authentication ([src/auth.ts](src/auth.ts)). Unset → no rows.
- Row-level security on the base tables is a second, independent layer.
- `events.data` / `"setValue"` are never exposed; GPS is rounded to 2 decimals.
- [tests/isolation.test.ts](tests/isolation.test.ts) checks all of this with plain SQL, no AI.

Setup on an existing database: `npm run db:schema`, then (demo data only) `npm run db:tenants` to create three demo clients. Until JWT sign-in is configured, development requests act as `DEV_CLIENT_ID` (header `X-Dev-Client-Id` picks another client for testing); production refuses all requests.

---

## Model Choice & Hardware Requirements

- **Model:** set `PLANNER_MODEL` in `.env` (default `llama3.2:3b`, about 2 GB, runs on a laptop CPU)
- **Speed:** about 5–15 s per question on a CPU-only laptop; about 1 s with a GPU
- **Accuracy:** bigger models (7–8B, ideally on a GPU) understand follow-ups and corrections much better
- **Inference server:** local Ollama (`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434`). Without it the app can't answer.

---

## Directory Structure

```
local-ai-analyst/
├── database/
│   └── schema.sql              # PostgreSQL DDL (tables, constraints, indexes)
├── scripts/
│   ├── apply-schema.ts         # Applies schema & grants SELECT-only to analyst_user
│   ├── check-db.ts             # Health check & read-only permission test
│   ├── seed.ts                 # Deterministic synthetic data generator (Mulberry32 PRNG)
│   ├── reset-db.ts             # Localhost-guarded FK-safe database reset
│   └── query.ts                # Interactive CLI tool for natural language queries
├── src/
│   ├── config.ts               # Configuration schema & strict localhost safety guards
│   ├── db/
│   │   └── pool.ts             # Read-only application pool & admin migration pool
│   ├── analytics/
│   │   └── query-builder.ts    # Query plan -> parameterized, read-only SQL
│   ├── ai/
│   │   ├── planner.ts          # Local LLM (Ollama) turns each question into a JSON query plan
│   │   ├── plan-answer.ts      # Runs the plan and writes the answer from the rows
│   │   ├── reports.ts          # Status / explain / compare / fleet-overview answers
│   │   ├── plan-examples.ts    # Corrections saved from "Not right?" / npm run fix
│   │   ├── format.ts           # Answer formatting and follow-up context
│   │   ├── query-log.ts        # logs/queries.jsonl
│   │   └── agent.ts            # Entry point: plan, run, answer
│   ├── routes/
│   │   └── chat.ts             # POST /api/chat, /api/chat/fix, /api/chat/fix/save
│   ├── app.ts                  # Express application, static UI, /health
│   └── server.ts               # Server listener, model warm-up, graceful shutdown
├── public/                     # Chat UI (index.html, style.css, app.js)
├── tests/
│   └── analytics.test.ts       # 21 unit tests for bounds, joins, NULLs, thresholds
├── docs/
│   └── demo-questions.md       # 10 documented demo questions with ground truth
├── docker-compose.yml          # Local PostgreSQL 16 container definition
├── .env.example                # Example environment variables with documentation
├── .gitignore                  # Security-first ignore rules (.env, dumps, node_modules)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Quickstart Guide

### 1. Prerequisites
- **Node.js:** v18+ LTS (v24 LTS tested)
- **Docker & Docker Compose** (or local PostgreSQL)
- **Ollama:** Installed locally ([ollama.com](https://ollama.com))

### 2. Installation
Clone the repository and install dependencies:
```bash
npm install
```

Copy the example environment configuration:
```bash
cp .env.example .env
```
*(On Windows PowerShell: `Copy-Item .env.example .env`)*

### 3. Start Local PostgreSQL
Start PostgreSQL in the background using Docker Compose:
```bash
docker compose up -d postgres
```
*Note: The container maps to host port `5434` to avoid collisions with any existing local PostgreSQL service running on `5432`.*

To stop the database later:
```bash
docker compose down
```

### 4. Initialize Database Schema & Permissions
Apply the database tables and configure the `analyst_user` read-only role:
```bash
npm run db:schema
```

Verify that the database is healthy and read-only permissions are enforced:
```bash
npm run db:check
```

### 5. Deterministic Synthetic Seeding
Populate the database with reproducible test data:
```bash
npm run db:seed
```
*Output Summary:*
- 25 devices
- 50 consignments
- 68 device-consignment mappings
- 13,380 sensor telemetry pings (5-minute frequency)
- 98 events (temperature excursions, warnings, shock, low battery)

To reset the database cleanly:
```bash
npm run db:reset
```
*(Protected by strict localhost hostname validation to prevent accidental execution against remote environments).*

### 6. Pull the Local Model
Start Ollama (`ollama serve`) and download the model:
```bash
ollama pull llama3.2:3b
```

### 7. Run Unit Tests
Run the tests (they need the seeded database):
```bash
npm test
```

### 8. Start the Application
Start the development server with live reload:
```bash
npm run dev
```

The application is now running at:
- **Chat:** [http://127.0.0.1:3000](http://127.0.0.1:3000)
- **Health Check:** [http://127.0.0.1:3000/health](http://127.0.0.1:3000/health)
- **Chat API:** `POST http://127.0.0.1:3000/api/chat`

---

## Teaching & Deployment

- **[docs/training.md](docs/training.md)**: correcting the model's mistakes so it learns (**Not right?** in the chat, or `npm run fix`).
- **[docs/deploy-ec2.md](docs/deploy-ec2.md)**: running the full stack on a single EC2 instance with Docker Compose.

---

## Using the CLI Query Tool

You can also run natural-language inquiries directly from your terminal:
```bash
npm run query -- "Which shipments went outside their temperature limits this week?"
```
```bash
npm run query -- "Are there any problems right now?"
```
```bash
npm run query -- "Compare shipments 1001 and 1002"
```

---

## What it can answer

Any of temperature, humidity, battery, light, acceleration, number of readings, alerts, temperature-limit violations, time out of range or last report — as an average, minimum, maximum, count or latest value — grouped by device, shipment, device type, origin, destination, route, hour, day or alert type, filtered by shipment, device, device type, city, status, alert type/level or above/below a value, over any time window, optionally compared with the period before. Plus lists of shipments, devices, alerts and raw readings, health reports for a shipment or device, side-by-side shipment comparisons and a fleet problem overview.

---

## Security Implementation

1. **Least-Privilege Database Role:** The web service and agent connect using `analyst_user`, which only has `SELECT` privileges on the `public` schema. Attempted writes or DDL are rejected with PostgreSQL error `42501` (`permission denied`).
2. **Localhost Guards:** Destructive actions (`db:reset`, `db:seed`, `db:schema`) validate that the target database hostname is strictly `127.0.0.1` or `localhost`.
3. **No Dynamic SQL:** All queries are parameterized with `$1`, `$2`, etc. User inputs and model arguments are parsed and validated via Zod schemas before SQL execution.
4. **Local-Only Model Inference:** All inference is executed against Ollama locally over loopback. No network telemetry or external APIs are invoked.

---

## Troubleshooting

- **PostgreSQL port collision (5432):**
  If port 5432 is already bound by a local service, Docker Compose maps container port 5432 to host port **5434**. Check `.env` to verify `POSTGRES_PORT=5434`.
- **Ollama service not running:**
  Verify Ollama is started:
  ```bash
  curl http://127.0.0.1:11434/api/tags
  ```
  If needed, run `ollama serve`.
- **CPU Inference latency:**
  On laptop CPUs without GPU acceleration, tool-calling inference may take 20–50 seconds per round. The request timeouts in `ollama.ts` and `chat.ts` are set to 120 seconds to prevent premature disconnection.
