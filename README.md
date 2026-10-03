# SKYWARD Lite

> **SIMULATION, NOT FOR OPERATIONAL USE.** SKYWARD Lite is a research prototype running on fictionalized airspace. It is not connected to any real FAA system, aircraft or radio, and it must never be presented or used as a real air traffic control tool.

SKYWARD Lite is a multi-agent air traffic control prototype that runs on Cloudflare's free tier. Planning agents propose actions, a Safety Monitor checks each proposal, an Arbiter merges them, a human controller accepts or rejects on a live radar console, and the simulated aircraft obey. Independent safety nets keep alerting even when every planning agent is switched off. Several people can work different controller positions on the same live picture.

**Live:** https://skyward-lite.troche.workers.dev

The specification and the implementation plan this repo is built from are in [`docs/`](docs/):

- [SKYWARD Multi-Agent National Air Traffic Control System: Specification](docs/SKYWARD%20Multi-Agent%20National%20Air%20Traffic%20Control%20System%20-%20Specification.md)
- [SKYWARD Lite Prototype Implementation Plan on Cloudflare Free Tier](docs/SKYWARD%20Lite%20Prototype%20Implementation%20Plan%20on%20Cloudflare%20Free%20Tier.md)

---

## Contents

- [Quick start](#quick-start)
- [Using the console](#using-the-console)
- [Architecture](#architecture)
- [Agents](#agents)
- [Scenarios and acceptance tests](#scenarios-and-acceptance-tests)
- [Testing](#testing)
- [Deploying](#deploying)
- [API and WebSocket protocol](#api-and-websocket-protocol)
- [Free-tier budget](#free-tier-budget)
- [Repository layout](#repository-layout)
- [Implementation notes and known limits](#implementation-notes-and-known-limits)

---

## Quick start

Requirements: Node.js 20+ and a Cloudflare account (only needed for Workers AI locally and for deploying).

```bash
npm install
npm run dev          # builds the console and starts wrangler dev on http://localhost:8787
```

Open http://localhost:8787, pick a scenario, and click **Create session**. Share the six-character room code with someone else to work a second position.

Workers AI (the Explainer and Briefer text roles) runs remotely even under `wrangler dev`, so run `npx wrangler login` first. If AI is unavailable, the console falls back to deterministic template text.

| Script | What it does |
| --- | --- |
| `npm run dev` | Build the console, run the Worker and Durable Objects locally |
| `npm run build` | Bundle `console/src` into `public/app.js` with esbuild |
| `npm test` | Headless acceptance suite (Vitest): 10 scenarios, replay, 1,000-run Safety Monitor validation, unit tests |
| `npm run test:e2e` | Playwright UI tests against a local `wrangler dev` (or `BASE_URL=…` for a deployment) |
| `npm run typecheck` | TypeScript checks for the Worker and the console |
| `npm run deploy` | Build and `wrangler deploy` |

---

## Using the console

The console is laid out like a radar position: scope on the left, decisions on the right, and comms along the bottom.

- **Banner:** simulation notice, room code, scenario, position picker (CTR-NW, CTR-SE, APP, TWR, SUP supervisor, OBS observer), sim clock, speed, sweep latency, link status, and who holds which position.
- **Alert bar:** safety-net alerts (CA conflict, MSAW terrain, RWY runway, EMERG emergency squawk, READBACK mismatch). Click an alert to flash its aircraft on the scope; **ACK** acknowledges it.
- **Radar scope:** range rings every 10 NM, sector boundaries, runways and extended centerlines, fixes, and high-terrain cells. Each target shows a history trail, a one-minute velocity leader, and a 3-line data block: callsign, altitude in hundreds of feet with cleared altitude and ground speed in tens of knots, and type/wake when selected. Drag to pan, scroll to zoom, click a target to select it, right-click a target for a clearance menu, shift-drag (or use **Measure**) for range and bearing, and drag a data block to move it. Conflict pairs show a red dashed line for as long as the safety net holds the alert.
- **Advisory queue:** up to 3 advisories per position, each showing its source agent, precedence, command, rationale, predicted effect and an expiry countdown. Actions are **Accept** (one action), **Edit** (pre-fills the command line, and Enter accepts the edited clearance), **Reject** with a reason code, and **Why?**, which shows the Workers AI Explainer sentence. Expired advisories fade out on their own. The advisory that resolves an active alert is outlined.
- **Flight strips:** one per owned or inbound flight, in sequence order. Drag a strip to reorder it, click to select. Inbound strips have an **Accept handoff** button.
- **Comms log and command line:** every clearance, readback and frequency change, rendered as phraseology. Press `/` to focus the command line.
- **Supervisor panel** (SUP position): workload per position, agent on/off switches, pause/resume, speed ×1/×2/×4, traffic level, scenario restart, and combine/split positions.
- **Relief brief:** a Workers AI position-relief briefing built from the last 10 minutes of events.
- **Replay:** `#/replay/<CODE>` re-simulates the session in the browser from its seed plus event log, and lets you scrub through it sweep by sweep.
- **Theme:** dark scope by default, with a light theme for projectors.

### Command language

Type a callsign followed by one or more instructions, for example `DAL123 H250 D060 S210`:

| Command | Meaning |
| --- | --- |
| `H250` | Fly heading 250 |
| `D060` / `C120` / `A080` | Descend / climb / altitude to 6,000 / 12,000 / 8,000 ft (hundreds of feet) |
| `S210` | Speed 210 kt |
| `DCT NWARD` | Proceed direct to a fix |
| `ILS 27L` | Cleared ILS approach to runway 27L (via the base fix when inbound to it) |
| `LUAW 27L` / `CTO 27L` | Line up and wait / cleared for takeoff |
| `RES` | Resume own navigation |
| `HO` | Accept an inbound handoff |

Controllers can only clear flights their position owns. The supervisor can act on any flight.

### Airspace (fictionalized)

The simulated area is an Atlanta-style TRACON (APP within 35 NM below FL180, TWR within 5 NM below 3,500 ft) and two en route sectors (CTR-NW and CTR-SE, out to 110 NM). It has parallel runways 27L/27R 1.5 NM apart, four arrival corridors (NWARD, NOLLY, SEGRL, SOWWY), two base fixes (NORTB, SOUTB) and two departure gates (DEPNW, DEPSW). High terrain to the north drives MSAW. Separation minima are 3 NM / 1,000 ft in the terminal area, 5 NM / 1,000 ft en route, and 2.5 NM in trail on the same final, with RECAT-style wake spacing.

---

## Architecture

```
                         ┌──────────────────── Cloudflare (free plan) ────────────────────┐
 Browser console         │                                                                 │
 (TypeScript, Canvas 2D) │   Worker (src/worker.ts)  ── REST, governor, Workers AI ──┐     │
   │  static assets ─────┼─▶ Static Assets (public/)                                  │     │
   │                     │                                                            ▼     │
   │  WS #1 traffic ─────┼─▶ Airspace DO (1 per session)               Lobby DO (singleton)
   │      + advisories   │     ├ Sim World + Track (raw frames)          rooms, sessions,  │
   │                     │     ├ Trajectory, Separation, Center Flow,    usage counters,   │
   │                     │     │ Sequencer, Sector, Workload, Datalink   governor          │
   │                     │     ├ Safety Monitor ─▶ Arbiter ─▶ ≤3 advisories / position    │
   │                     │     ├ scripted controller for unstaffed positions               │
   │                     │     └ SQLite: events (append-only), snapshots, session          │
   │                     │            │ raw frame per sweep (RPC)                          │
   │  WS #2 alerts ──────┼─▶ SafetyNet DO (1 per session): CA, MSAW, runway, emergency     │
   │                     │     SQLite: alerts                                              │
   │                     │   Workers AI: Explainer ("why"), Briefer (relief briefing)      │
                         └─────────────────────────────────────────────────────────────────┘
```

- **Two sockets per console.** Alerts from the SafetyNet DO reach the console even if the agent runtime in the Airspace DO is switched off or fails.
- **Server-authoritative, sparse simulation.** The world advances once per 4.8 s radar sweep, driven by a Durable Object alarm. The scope does not interpolate, matching terminal radar.
- **WebSocket Hibernation API.** Sockets use `ctx.acceptWebSocket()`, and the alarm stops after `IDLE_PAUSE_MS` (10 min) with nobody connected.
- **LLMs off the hot path.** Workers AI runs only when a controller clicks **Why?** or asks for a briefing. LLM text is never parsed into clearances, and a deterministic validator rejects any explanation that introduces numbers absent from the advisory.
- **Deterministic core.** The simulation uses seeded RNG streams that are separate for traffic and pilots, readback errors, and radar noise. A session replays bit-for-bit from `scenario + seed + logged controller actions`.

The simulation and agents live in plain TypeScript (`src/sim`, `src/agents`, `src/engine`) with no Cloudflare APIs. The same code runs inside the Airspace DO, headless in Vitest, and in the browser for replay.

### The advisory loop

1. Each sweep, the Track agent publishes a raw frame to the SafetyNet DO before any planning runs.
2. Agents run, each isolated by `try/catch`, and submit proposals.
3. The **Safety Monitor** re-checks every proposal with its own separately written projector (constant ground speed, standard-rate turns, 10-minute horizon). It drops any proposal that creates or worsens a loss of separation, or that busts terrain. An agent with repeated drops is suspended for 2 minutes.
4. The **Arbiter** dedupes, applies the precedence order from the specification (1 safety nets, which bypass it; 2 separation; 3 recent controller instructions; 4 emergencies; 5 flow; 6 efficiency), and delivers at most 3 advisories per position, each with an expiry.
5. A human accepts, edits or rejects the advisory. Positions with nobody on them are worked by a scripted controller, and handoffs to them complete by silent consent after 10 s (authority level 2).
6. The Datalink agent renders phraseology. The simulated pilot reads back after 3-8 s (2% of readbacks contain a wrong digit) and flies the clearance. A readback mismatch raises a READBACK alert.

---

## Agents

| Agent | Runs | What it does |
| --- | --- | --- |
| Sim World | every sweep | Point-mass kinematics, 5 performance classes, layered wind, pilot model (delays, readbacks, 7700/7600/engine-out), seeded traffic generator |
| Track | every sweep | Raw surveillance frame with radar noise for the safety nets; occasional dropouts (coasting targets) on the console |
| Flight Data | events | Flight plans, cleared altitude/heading/speed (shown as issued even when the pilot flies something else) |
| Trajectory | every sweep | 20-min prediction at 10 s steps from state plus intent, assuming arrivals will be cleared for the approach |
| Separation Assurance | every sweep | Pairwise 20-min probe; inside an 8-min action horizon, at least 2 ranked altitude/vector/speed resolutions re-checked against all traffic; returns vectored aircraft to their route |
| Center Flow | every 30 s | Runway times (STA) with wake spacing; en route speed advisories that never compress the stream behind |
| Terminal Sequencer | every 30 s (immediately on an emergency) | Wake-spaced approach clearances (landing time ≥ leader + RECAT interval); departure releases into arrival gaps |
| Sector agents | every sweep | Handoffs 3-5 min before the boundary, emergency handling, descent profile and climb-to-requested advice |
| Workload | every 60 s | Per-position score (aircraft + 3×conflicts + pending); split and combine recommendations |
| Datalink | on clearance and readback | Phraseology and readback check |
| Safety Monitor, Arbiter | every proposal | See above |
| Safety Nets | every raw frame, in the SafetyNet DO | CA (2-min linear look-ahead), MSAW (30 s, with approach and departure inhibit areas), runway (conflicting line-up/takeoff vs arrival within 2.5 NM), emergency squawks |
| Explainer, Briefer | on demand | Workers AI `@cf/meta/llama-3.2-3b-instruct` |
| National Flow, Surface, Oceanic, Weather | — | Stubs listed in the roster (v2) |

The supervisor can switch any agent off. With **Separation** off, advisories disappear but the SafetyNet DO still raises conflict alerts. With **Sector** off, handoffs fall back to legacy automatic handoff at the boundary ("fail to today").

---

## Scenarios and acceptance tests

Scenarios are JSON files in [`scenarios/`](scenarios/). Each one defines the aircraft, wind, scheduled events and expected outcomes. All ten acceptance scenarios from the plan pass headless in Vitest with a scripted controller, and the interactive ones are also exercised through the UI in Playwright.

| # | Scenario | Pass criteria (verified) |
| --- | --- | --- |
| 1 | Head-on en route conflict | Separation advisory ≥ 5 min before LOS; the accepted resolution keeps 5 NM / 1,000 ft |
| 2 | Crossing conflict, one climbing | Altitude or vector resolution; no loss of separation anywhere afterwards |
| 3 | Agents off, conflict alert on | No advisory; SafetyNet CA 90-150 s before LOS on 5 different seeds |
| 4 | Arrival surge (70/h, 2 runways, 90 min) | ≥ 40 landings, every pair meets RECAT spacing, average runway time error < 30 s (≈ 9 s measured) |
| 5 | Terrain | MSAW within one sweep of going below the minimum safe altitude |
| 6 | Runway incursion | RWY alert within one sweep of the conflicting line-up clearance |
| 7 | Emergency (7700) | EMERG alert on every console within one sweep; emergency advisory within 5 s |
| 8 | Lost comms (7600) | NORDO flight holds its heading and altitude; only the other aircraft is advised |
| 9 | Wrong readback | READBACK alert before the aircraft reaches the wrong altitude |
| 10 | Multiplayer handoff | Proposed 3-5 min out, waits for the human receiver, ownership moves, both consoles agree within one sweep |

Non-functional acceptance:

- **Safety Monitor:** 0 unsafe advisories across 1,000 randomized fast-time runs. Each delivered advisory is verified against the true simulation, and the last run delivered 296 separation advisories with 0 escapes.
- **Replay:** a session replays to an identical world-state hash from its event log and seed, and a snapshot restored mid-session continues identically.
- **Latency:** the sweep reaches the console in under 300 ms (asserted in Playwright, locally and against production).
- **Budget:** see [Free-tier budget](#free-tier-budget).

Two free-play presets (`free-light`, `free-busy`) generate continuous traffic for demos.

---

## Testing

```bash
npm test                         # 31 Vitest tests, ~40 s (FAST_TIME_RUNS=200 for a quicker run)
npm run test:e2e                 # 20 Playwright tests; starts wrangler dev on :8788 automatically
BASE_URL=https://skyward-lite.troche.workers.dev npm run test:e2e   # against a deployment
```

The plan suggested Vitest + Miniflare. Because the whole engine is pure TypeScript, the headless suite drives it directly, as the plan intended: fast-time runs stay off Cloudflare. Durable Object, socket and REST behavior is covered end to end by Playwright against `wrangler dev` (workerd) and against the deployment.

---

## Deploying

```bash
npx wrangler login
npm run deploy
```

One `wrangler deploy` publishes the Worker, the static console and the three SQLite-backed Durable Object classes ([`wrangler.jsonc`](wrangler.jsonc)). No Pages project, D1, KV or R2 is needed.

Free-plan budgets and the governor threshold are plain config in `wrangler.jsonc` `vars`, so they can change without a code change:

```jsonc
"BUDGETS": { "doRequests": 100000, "doRowsWritten": 100000, "doDurationGbS": 13000, "workerRequests": 100000, "aiNeurons": 10000 },
"GOVERNOR_THRESHOLD": 0.8,   // refuse new sessions at 80% of any daily budget
"AI_MODEL": "@cf/meta/llama-3.2-3b-instruct",
"IDLE_PAUSE_MS": 600000      // stop the sweep alarm 10 min after the last controller leaves
```

---

## API and WebSocket protocol

All messages are JSON with a `type` field and schema version `v: 1`. The types are in [`src/shared/types.ts`](src/shared/types.ts).

| Method and path | Purpose |
| --- | --- |
| `POST /api/sessions` `{scenario, seed?, traffic?}` | Create a session (the governor checks the budget first) → `{code}` |
| `GET /api/sessions` | Sessions active in the last 24 h |
| `GET /api/scenarios` | Scenario library |
| `GET /api/sessions/:code/replay?from=&to=` | Event log of the current epoch (plus scenario, seed, current tick) |
| `POST /api/explain` `{session, advisoryId}` | One-sentence explanation (Workers AI, validated, with template fallback) |
| `POST /api/brief` `{session, position}` | Position relief briefing |
| `GET /api/usage` | Today's consumption vs the free-tier budget |
| `GET /ws/airspace/:code?name=` | Traffic, advisories, handoffs, comms, presence, status |
| `GET /ws/safety/:code` | Safety-net alerts only |

Server to console: `welcome`, `sweep` (delta-encoded, with `sentAt`), `advisories`, `alert`/`alerts`, `handoff`, `comms`, `presence`, `status`, `error`.
Console to server: `hello`, `claim`, `clearance`, `advisory.accept` (optional edited clearance), `advisory.reject` (reason code), `handoff.accept`, `agent.toggle` and `sim.control` (both supervisor only), `alert.ack`.

Storage (SQLite in each Durable Object): `events` (append-only audit and replay source), `snapshots` (gzip JSON every 30 s), `session`, `alerts` (SafetyNet DO), and `sessions`/`usage` (Lobby DO).

---

## Free-tier budget

Durable Object duration is the binding limit, so the design keeps objects asleep whenever possible.

- The sweep alarm runs only while someone is connected, or for up to `IDLE_PAUSE_MS` after the last one leaves. Pausing the simulation deletes the alarm.
- Rows are written per event and per 30-second snapshot, never per aircraft per tick.
- Outgoing socket messages are free. Incoming messages are counted at 20:1.
- The Airspace DO reports estimated requests, rows written and GB-s to the Lobby every 60 s. `/api/usage` and the lobby meters show the totals, and the governor refuses new sessions at 80% of any daily limit.

These are estimates kept by the app. Cloudflare's dashboard remains the source of truth.

---

## Repository layout

```
docs/                    specification + implementation plan (source of truth)
scenarios/               JSON scenario library + index.ts
src/worker.ts            router, governor, REST, Workers AI roles
src/do/airspace.ts       Airspace DO: sweep alarm, agent runtime host, event log, snapshots, WS
src/do/safetynet.ts      SafetyNet DO: independent alerting + its own WS
src/do/lobby.ts          Lobby DO: rooms, sessions, usage counters, governor
src/engine/session.ts    SessionEngine: world + agents + monitor + arbiter + scripted controller
src/engine/replay.ts     deterministic replay from seed + event log
src/agents/*.ts          one file per agent actor (+ safetyMonitor, arbiter)
src/safety/nets.ts       CA, MSAW, runway, emergency (no sim/agent imports)
src/sim/                 world, pilot model, traffic generator, seeded RNG, scenario schema
src/shared/              types, fictionalized airspace adaptation data, command language
console/src/             web console (TypeScript, Canvas 2D, no framework)
public/                  static assets (index.html, styles.css, bundled app.js)
test/                    Vitest headless acceptance + unit tests
e2e/                     Playwright UI tests
wrangler.jsonc
```

---

## Implementation notes and known limits

- **Not real ATC.** The sim uses flat-earth kinematics, simplified performance, fictionalized procedures, and simplified separation logic that is not formally verified. Nothing here carries over to an operational system without certified, formally verified replacements (spec section 8).
- **Agents are co-hosted** in one Durable Object per session to fit the free-tier duration budget. Isolation comes from `try/catch` per actor, and each agent has a typed input/output so it can move into its own object on a paid plan. The safety nets run in a separate object.
- **The scripted controller** works unstaffed positions so traffic keeps flowing with only one or two humans. The supervisor sees every position's advisories.
- **Snapshots every 30 s.** If a Durable Object is evicted mid-session, the session resumes from the last snapshot, so up to 30 s of sim time may be lost. Replay always re-simulates from the start of the epoch.
- **Throughput.** In the surge preset the two arrival runways land about 47 aircraft per hour at steady state, and the excess demand holds at the base fixes.
- **LLM text is advisory only.** Briefings come from a 3B model and can contain inaccuracies. They are labeled in the UI and never feed back into clearances.
- **Not in v1:** push-to-talk transcription, the offline ADS-B replay script, and the National Flow, Surface, Oceanic and Weather agents (listed as stubs).
