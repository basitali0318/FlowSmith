# FlowSmith AI

**Turn plain-language process descriptions, SOP documents and meeting notes into validated BPMN 2.0 diagrams - then find the bottlenecks.**

Business analysts, SMEs, students and process-improvement teams can model processes without BPMN expertise.
FlowSmith extracts the process, generates BPMN XML, **validates it against the BPMN 2.0 schema, repairs mistakes automatically**,
and flags bottlenecks, redundant steps and missing exception paths with concrete improvement suggestions.

> **Demo login:** `demo@flowsmith.ai` / `Demo@1234` (dummy credentials; also available as a one-click button on the login page).

## What the MVP does

| Capability | How |
|---|---|
| Input | Free text, SOP upload (`.docx`, `.pdf`, `.txt`, `.md`), three built-in samples |
| Extraction | Actors, tasks, decisions (If/Otherwise), parallel work, loops, terminal outcomes, hand-offs |
| BPMN generation | BPMN 2.0 XML with pool, **one swimlane per actor**, exclusive/parallel gateways, full diagram layout |
| Validation | `bpmn-moddle` schema parse + structural rules (start/end, dead ends, reachability, unlabeled gateways, broken refs) |
| Repair loop | Validate -> repair -> regenerate, **max 3 retries** (LLM-assisted when an LLM is active, deterministic safety net always) |
| Analysis | Workload concentration, sequential approvals, duplicated steps, decisions without failure paths, hand-off density, long critical paths |
| Advisor | Prioritised suggestions (impact / effort); click a finding to highlight the affected steps on the diagram |
| Editor | `bpmn-js` modeler - edit on canvas, **Save** re-validates; export `.bpmn`, `.svg`, `.png` |
| Platform | NestJS API, JWT auth, rate limiting, job queue with live pipeline progress, PostgreSQL persistence |

## Architecture (see [`docs/flowsmith-architecture.mmd`](docs/flowsmith-architecture.mmd))

```
React (Chat/Upload + bpmn-js) -> NestJS (JWT + rate limit -> Orchestrator -> Queue)
  -> LangGraph: Extractor -> Generator -> Validator --invalid--> Repair (max 3) -> Generator
                                            \--valid--> Analyzer -> Advisor
  -> Open-source LLM (Groq / Ollama / vLLM)        -> PostgreSQL
```

The LangGraph state machine lives in [`backend/src/pipeline/graph.ts`](backend/src/pipeline/graph.ts).

### Two engines, one pipeline
- **LLM engine** - open-weight models (on Groq the model is auto-selected from the key's live model list - verified live with `openai/gpt-oss-120b` after Groq retired Llama 3.3 for that key; Qwen2.5 / Llama 3.1 via self-hosted Ollama or vLLM) return a structured process graph (JSON-schema constrained on Ollama, JSON mode on Groq/vLLM). The same graph feeds the deterministic BPMN generator, so XML is always well-formed.
- **Rules engine** - a deterministic NLP extractor. It is the automatic fallback when no model server is reachable or the LLM call fails, so **the product always returns a diagram** (and the hosted demo works even without a GPU or API key).

`Engine: Auto` (default) uses the LLM when reachable and falls back to rules, and the UI shows which engine produced each diagram.

## Run it

```bash
cp .env.example .env            # add GROQ_API_KEY (optional - without it the rules engine is used)
npm install
npm run build
npm start                       # http://localhost:3000   (in-memory storage unless DATABASE_URL is set)
```

With PostgreSQL + Docker: `docker compose up --build` (add `--profile local-llm` for Ollama).
Development: `npm run dev:backend` and `npm run dev:frontend` (Vite proxies `/api`).
Tests: `npm test` (18 tests: extractor, validator, repair loop, generator, LLM path against a mock OpenAI-compatible server, full HTTP API).

### Deploy a public demo link
1. Push this repo to GitHub.
2. Render -> **New > Blueprint** -> select the repo (uses [`render.yaml`](render.yaml): Docker web service + free Postgres).
3. In the service's **Environment** tab set `GROQ_API_KEY`. Share the service URL + the demo credentials above.

Secrets are read from environment variables only; nothing sensitive is committed (`.env` is git-ignored).

## Configuration

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `groq` (default if `GROQ_API_KEY` set), `ollama`, `openai` (vLLM / any compatible server), `none` |
| `GROQ_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`, `OLLAMA_URL` | Model server settings |
| `DATABASE_URL` | PostgreSQL; schema is created automatically. Omit for in-memory storage |
| `JWT_SECRET` | Token signing secret (set it in production) |
| `DEMO_EMAIL`, `DEMO_PASSWORD`, `SHOW_DEMO_CREDENTIALS` | Seeded demo account |
| `RATE_LIMIT`, `GENERATE_RATE_LIMIT` | Requests / minute / IP |

## API

`POST /api/auth/login` · `POST /api/auth/register` · `GET /api/health` · `GET /api/samples`
`POST /api/processes` (multipart: `description`, `file`, `engine`) -> `{ id }` · `GET /api/processes/:id` (poll for status + live trace) ·
`GET /api/processes` · `PUT /api/processes/:id/xml` (save + re-validate) · `DELETE /api/processes/:id`

## MVP scope and roadmap (honest notes)

| Architecture box | MVP status |
|---|---|
| Job queue (BullMQ) | In-process queue with bounded concurrency behind a single `enqueue()` seam - swap for BullMQ + Redis when scaling horizontally |
| pgvector / `nomic-embed-text` SOP retrieval | Not in the MVP. Uploaded SOPs are parsed and processed directly (up to 15k characters). The docker-compose DB image is already pgvector-enabled |
| Object storage for uploads/exports | Uploads are processed in memory; exports are generated in the browser (BPMN, SVG, PNG). PDF export is on the roadmap |
| Prisma | PostgreSQL via `pg` with auto-created schema (no engine download needed) |
| Rules engine | English only; best on SOP-style sentences ("The manager approves...", "If ..., ... Otherwise, ...") |

Tech: NestJS 11 · LangGraph.js · bpmn-moddle · bpmn-js · React 18 + Vite · PostgreSQL · Groq / Ollama / vLLM.

## Install from GitHub Packages (npm)

The backend + bundled web app is published as `@basitali0318/flowsmith` on the GitHub npm registry
([docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)).

```bash
# one-time: authenticate (token needs read:packages) and map the scope
echo "@basitali0318:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc

GROQ_API_KEY=... npx @basitali0318/flowsmith      # serves the app on http://localhost:3000
```

Publishing is automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml) (Actions tab -> *Publish package* -> Run workflow, or publish a GitHub Release).
Real-API verification of the Groq engine: add repo secret `GROQ_API_KEY`, then run *Groq live check* (or locally `npm run test:live -w backend`).

## Live deployment check

`node scripts/smoke.mjs https://<your-deployment>` (or the *Live smoke test* workflow) logs in and generates every sample with `engine=llm`.
It fails unless the real LLM produced the result, and prints the model that was used. Last verified run: all 3 samples PASS on Vercel with Groq (`openai/gpt-oss-120b`), 3.5-5.5 s each, 0 repairs needed.
