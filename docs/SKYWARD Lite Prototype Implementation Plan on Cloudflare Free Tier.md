# SKYWARD Lite: Prototype Implementation Plan on Cloudflare Free Tier

Oct 2, 2026 · @Jose

## 1. Goals and non-goals

SKYWARD Lite proves the SKYWARD agent architecture end to end, with a live multi-controller radar console, on simulated Atlanta airspace (one TRACON plus two en route sectors) at a running cost of zero dollars on Cloudflare's free plan.

### Goals

1. Run the spec's agent roster (scaled down) as cooperating agents, each with its own state and message contract.
2. Show the full advisory loop: agent proposes, Safety Monitor checks, Arbiter merges, a human controller accepts or rejects on the console, the simulated aircraft obeys.
3. Demonstrate independent safety nets that alert even when every planning agent is switched off.
4. Support several people at once, each working a different controller position on the same live picture (multiplayer).
5. Replay any session second by second from the event log.
6. Be buildable from spec files in a GitHub repo with Claude Code, and deployable with one `wrangler deploy`.

### Simulated airspace

- **Atlanta TRACON (A80)-style terminal area**: two parallel arrival runways at a fictionalized ATL, four arrival corridors, two departure gates.
- **Two en route sectors** feeding it from the northwest and southeast, simplified from Atlanta Center (ZTL) geometry.
- Real-world-like separation rules: 3 NM / 1,000 ft terminal, 5 NM / 1,000 ft en route, RECAT-style wake spacing on final.

### Non-goals

- No connection to real FAA systems, real aircraft, or real radios. **The prototype must never be presented as usable for real air traffic control.**
- No certification artifacts (DO-278A, SRM) beyond a sample hazard log.
- No oceanic, national flow or surface agents in v1; they appear as stubs in the roster.
- No real-time ADS-B ingestion in v1 (see section 5 for the optional offline replay).

## 2. Cloudflare free-tier limits and design constraints

The binding constraint is Durable Object duration (13,000 GB-s per day), which buys about 28 hours of one always-awake object; the design therefore runs the simulation only while a controller is connected and caps it at about 10 session-hours per day.

| Resource | Free-plan limit | How SKYWARD Lite uses it |
| --- | --- | --- |
| Worker requests | 100,000 / day; static asset requests free and unlimited | Worker only routes API calls and WebSocket upgrades; console HTML, JS and map data served as static assets |
| Worker CPU | 10 ms per invocation | Worker does no simulation work; all heavy logic runs inside Durable Objects |
| Durable Object requests | 100,000 / day, counting HTTP, each RPC call, alarm invocations and incoming WebSocket messages | One alarm per 4.8 s radar sweep; incoming WebSocket messages billed at 20:1; outgoing messages free |
| Durable Object duration | 13,000 GB-s / day, billed at 128 MB per object while active | Two objects awake per session (Airspace + Safety Net); auto-pause after 10 min with no controller |
| Durable Object CPU | 30 s per request by default | Tick target under 50 ms of CPU, far below the limit |
| Durable Object storage (SQLite) | 5M rows read / day; 100K rows written / day (each `setAlarm()` counts as one write); 5 GB total | Event log + one compressed snapshot row every 30 s, never one row per aircraft per tick |
| Workers AI | 10,000 neurons / day across all models | Plain-language advisory rationales and shift briefings on a small model; optional push-to-talk transcription |
| Free-plan behavior | Exceeding a limit makes further operations of that type fail; limits reset 00:00 UTC | A usage governor in the Worker refuses new sessions at 80% of any daily budget |

Sources: [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing) (page updated Sep 30, 2026), [Durable Objects limits](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/durable-objects/platform/limits.mdx), [Workers limits](https://developers.cloudflare.com/workers/platform/limits), [Workers pricing](https://developers.cloudflare.com/workers/about/pricing), [Workers AI pricing](https://developers.cloudflare.com:8443/workers-ai/platform/pricing/).

### Design rules that follow

1. **No tile server**: the radar map is drawn on a canvas from bundled vector data (sector boundaries, runways, fixes), so there is no third-party map quota.
2. **Simulation is server-authoritative but sparse**: the server advances the world once per radar sweep; the console interpolates nothing, matching how real terminal scopes jump each sweep.
3. **WebSocket Hibernation API everywhere**: sockets never use `accept()`, so idle objects stop billing duration.
4. **LLMs off the hot path**: Workers AI is called only when a human opens an advisory's "why" panel or asks for a briefing, never per tick.
5. **One-command deploy**: Worker + static assets + Durable Object classes in one `wrangler.jsonc`; no Pages project, no D1 needed.

## 3. Architecture

One Worker serves the console and routes traffic to three Durable Object classes: an Airspace DO per session that runs the simulation and all planning agents, an independent SafetyNet DO per session, and a singleton Lobby DO; Workers AI handles the two text-generation roles.

&#91;embedded content: SKYWARD Lite on Cloudflare · 1 Worker, 3 Durable Object classes, Workers AI\]

Each console opens two WebSockets, so alerts from the SafetyNet DO arrive even if the agent runtime in the Airspace DO is switched off or fails.

### Repository layout

```
skyward-lite/
  specs/                 # spec + this plan, source of truth for Claude Code
  scenarios/             # JSON scenario library
  src/worker.ts          # router, governor, REST
  src/do/airspace.ts     # Airspace DO: sim loop, agent runtime, bus, SQLite log
  src/do/safetynet.ts    # SafetyNet DO: independent alerting
  src/do/lobby.ts        # Lobby DO: rooms, usage counters
  src/agents/*.ts        # one file per agent actor
  src/shared/types.ts    # Flight, Advisory, Alert, BusEvent
  console/               # static web console (TypeScript, Canvas 2D)
  test/                  # Vitest + Miniflare scenario tests
  wrangler.jsonc
```

## 4. Agent-to-Cloudflare mapping

Agents are separate TypeScript actor classes with their own state and a typed message contract, co-hosted inside one Airspace Durable Object per session to fit the free-tier duration budget; the safety nets live in a second, independent Durable Object.

| Agent (prototype) | Spec equivalent | Runs in | Trigger | Implementation |
| --- | --- | --- | --- | --- |
| Sim World | Real aircraft and pilots | Airspace DO | Every 4.8 s alarm | Point-mass kinematics, turn and climb rates by aircraft type, pilot model that obeys clearances after 3-8 s delay |
| Track | Track Fusion | Airspace DO | Each sweep | Adds radar noise and occasional dropouts; publishes raw surveillance frame |
| Flight Data | Flight Data | Airspace DO | Events | Flight plans, cleared altitude, assigned heading and speed |
| Trajectory | Trajectory | Airspace DO | Each sweep | 20-min prediction at 10 s steps from intent + current state |
| Separation | Separation Assurance | Airspace DO | Each sweep | Pairwise probe (3 NM / 5 NM, 1,000 ft); ranked vector, altitude and speed resolutions |
| Center Flow | Center Flow | Airspace DO | Every 30 s | Assigns runway times; speed advisories to meet them |
| Terminal Sequencer | Terminal Sequencer | Airspace DO | Every 30 s | Builds final sequence with wake spacing; vectors for path stretch |
| Sector Agents (CTR-NW, CTR-SE, APP, TWR) | Sector Agent | Airspace DO | Events | Own flights per position, draft handoffs, assemble each position's advisory list |
| Workload | Workload | Airspace DO | Every 60 s | Simple score (aircraft count, conflicts, pending advisories); suggests combining or splitting positions |
| Datalink | Datalink | Airspace DO | On accept | Renders accepted advisory as phraseology text; simulated pilot readback, occasionally wrong to exercise the check |
| Safety Monitor | Safety Monitor | Airspace DO | Every proposal | Re-runs a minimal, separately written probe; drops any proposal that creates a conflict |
| Arbiter | Arbiter | Airspace DO | Every proposal | Dedupe, precedence order from the spec, max 3 active advisories per position |
| Safety Nets (conflict alert, MSAW, runway) | Independent safety nets | SafetyNet DO | Each raw frame | Separate code module, separate WebSocket to the console; keeps alerting with every agent switched off |
| Explainer | LLM text role | Worker + Workers AI | Controller opens "why" | Small instruct model turns the advisory's structured rationale into one plain sentence |
| Briefer | LLM text role | Worker + Workers AI | On demand | Position relief briefing from the last 10 min of events |
| Lobby and Governor | Infrastructure | Lobby DO (singleton) | Session start and end | Room codes, session list, daily usage counters |

An "agents off" switch per agent on the console proves the degradation story: turning off Separation removes advisories, while the SafetyNet DO still fires conflict alerts.

## 5. Simulation engine and traffic data

Traffic is synthetic by default, generated from seeded scenarios so every run is reproducible and every test has a known answer.

### World model

- Flat-earth local frame (NM east/north from the airport reference point) with altitude in feet; accurate enough over a 100 NM radius.
- Aircraft types grouped into 5 performance classes (regional jet, narrowbody, widebody, turboprop, business jet) with cruise speed, climb and descent rates, standard-rate turns and RECAT wake category.
- Wind as a single layered profile per scenario, applied to ground speed.
- Terrain and obstacles as a coarse minimum-altitude grid so MSAW has something real to protect.

### Pilot model

- Each aircraft follows its flight plan route and the latest clearance (heading, altitude, speed, direct-to, approach).
- Response delay 3-8 s after a clearance, plus realistic rates to reach the target.
- Readback generated as text; 2% of readbacks contain a wrong digit to exercise the readback check.
- Configurable emergencies: 7700 with descent request, 7600 lost comms (continues on last clearance), engine-out speed loss.

### Traffic generator

- Arrival rate per corridor (aircraft per hour) with random jitter; departures released from the runway at configured intervals.
- Seeded random so a scenario plus seed replays identically.
- Traffic level presets: light (20 aircraft/hour), busy (45), surge (70) to stress sequencing and workload.

### Scenario library (JSON files in the repo)

Each scenario defines airspace, runway configuration, wind, initial aircraft, scheduled events and expected outcomes (for automated tests). See section 10 for the list.

### Optional: offline real-traffic replay

- A local script (not part of the deployed app) converts a recorded ADS-B track file, such as an OpenSky Network historical extract, into a scenario JSON.
- Replayed aircraft fly the recorded paths until a controller issues a clearance, then hand over to the pilot model.
- Recorded data stays offline in the repo; the deployed app never calls a live ADS-B service, which keeps it within free quotas and clear of data-licensing questions.

## 6. Graphical control console

The console is a single static web page (TypeScript, Canvas 2D, no framework required) laid out like a real radar position: scope on the left, decisions on the right, voice-style comms along the bottom.

&#91;embedded content: Controller console layout · approach position during a conflict alert\]

The safety-net alert sits above everything, and the only highlighted control is the advisory that resolves it.

### Panels

| Panel | Shows | Interactions |
| --- | --- | --- |
| Banner | Simulation notice, position, sim clock, speed | Position picker; supervisor sim controls |
| Alert bar | Safety-net alerts (conflict, MSAW, runway, emergency, readback mismatch) | Acknowledge; click flashes the aircraft |
| Radar scope | Targets, 3-line data blocks (callsign; altitude in hundreds of feet and ground speed; type when selected), history trail, range rings, sector boundaries, runways, fixes | Pan, zoom, drag data block, click target to select, right-click for a clearance menu, measure tool (range and bearing) |
| Advisory queue | Up to 3 advisories with source, priority, action and expiry countdown | Accept, Edit (prefilled clearance), Reject with reason code; "why" opens the Explainer sentence |
| Flight strips | One strip per owned or inbound flight, in sequence order | Drag to reorder; click to select; handoff accept button on inbound strips |
| Comms log and command line | Phraseology for every clearance and readback | Type short commands (`DAL123 H250`, `AAL456 D060`, `SWA22 S210`); optional push-to-talk transcribed by Workers AI and parsed deterministically |
| Supervisor view | All positions, workload scores, agent status | Agent on/off switches, split or combine positions, traffic level, scenario restart |

### Console behavior rules

- The scope redraws only on each sweep message; selection and hover redraw locally.
- Conflict pairs turn red with a dashed line between them for as long as the safety net holds the alert.
- Advisories fade and disappear at expiry; nothing waits for a click indefinitely.
- Every controller action is echoed in the comms log and written to the event log, so replay shows exactly what was on screen.
- Dark scope theme by default (as real displays), with a light theme for demos on projectors.

## 7. Data model, REST API and WebSocket protocol

The console talks to the system over two WebSockets per controller (Airspace DO for traffic and advisories, SafetyNet DO for alerts) plus a handful of REST calls; all messages are JSON with a `type` field and a schema version.

### Core types

```typescript
type Flight = {
  id: string; callsign: string; type: string; wake: 'A'|'B'|'C'|'D'|'E'|'F';
  pos: { x: number; y: number }; alt: number; gs: number; trk: number; vs: number; // NM, ft, kt, deg, fpm
  squawk: string; owner: PositionId; cleared: { alt?: number; hdg?: number; spd?: number; direct?: string; approach?: string };
  plan: { origin: string; dest: string; route: string[] };
};

type Advisory = {
  id: string; source: AgentId; position: PositionId; flights: string[];
  action: Clearance[];             // e.g. [{ flight: 'DAL123', hdg: 250 }]
  rationale: { rule: string; inputs: Record<string, number> };
  predicted: { minSepNm: number; delaySec: number };
  priority: 1|2|3|4|5|6;           // spec precedence order
  authority: 0|1|2; expiresAt: number; modelVersion: string;
};

type Alert = { id: string; kind: 'CA'|'MSAW'|'RWY'|'EMERG'|'READBACK'; flights: string[]; severity: 'caution'|'warning'; at: number };

type BusEvent = { seq: number; t: number; kind: string; payload: unknown }; // append-only log
```

### REST (Worker)

| Method and path | Purpose |
| --- | --- |
| `POST /api/sessions` | Create session from a scenario and seed; returns room code (governor checks budget first) |
| `GET /api/sessions` | List live sessions |
| `GET /api/scenarios` | List scenario files |
| `GET /api/sessions/:id/replay?from=&to=` | Event log slice for replay |
| `POST /api/explain` | Advisory id in, one-sentence explanation out (Workers AI) |
| `POST /api/brief` | Position relief briefing (Workers AI) |
| `GET /api/usage` | Today's consumption vs free-tier budget |

### WebSocket: server to console

| Type | When | Contents |
| --- | --- | --- |
| `sweep` | Every 4.8 s | All flights visible to that position (delta-encoded), sim time |
| `advisories` | When the position's list changes | Up to 3 active advisories |
| `alert` | SafetyNet DO, immediately | Alert object |
| `handoff` | On proposal or accept | Flight, from, to, state |
| `comms` | On clearance or readback | Phraseology text log line |
| `presence` | Join, leave, position change | Who holds which position |

### WebSocket: console to server

| Type | Contents |
| --- | --- |
| `claim` | Position id to work (CTR-NW, CTR-SE, APP, TWR, or SUP for supervisor) |
| `clearance` | Flight + clearance typed or clicked by the controller |
| `advisory.accept` / `advisory.reject` | Advisory id, optional edited clearance, reject reason code |
| `handoff.accept` | Flight id |
| `agent.toggle` | Agent id, on or off (supervisor only) |
| `sim.control` | Pause, resume, speed x1 / x2 / x4 (supervisor only) |

### Storage (SQLite inside each Durable Object)

| Table | Rows written | Notes |
| --- | --- | --- |
| `events` | One per clearance, advisory decision, alert, handoff | Append-only; the audit and replay source |
| `snapshots` | One every 30 s | Whole world state, compressed JSON in one row |
| `session` | One | Scenario, seed, start time, positions |

## 8. Daily budget math

At 10 session-hours per day with 4 controllers, SKYWARD Lite uses about 69% of the Durable Object duration allowance and under 20% of everything else, so duration sets the ceiling: about 14 session-hours per day, and the governor stops new sessions near 11.

Assumptions: 4.8 s sweep (750 sweeps per hour); 4 controllers with 2 sockets each; about 120 controller actions per controller per hour; about 600 logged events and 120 snapshots per hour; both Durable Objects counted as awake for the whole session (worst case).

| Resource | Per session-hour | At 10 session-hours | Free daily limit | Share used |
| --- | --- | --- | --- | --- |
| DO requests (750 alarms + 750 SafetyNet RPC calls + 480 socket messages / 20 + 8 connections) | \~1,530 | \~15,300 | 100,000 | \~15% |
| DO rows written (750 setAlarm + \~600 events + 120 snapshots + \~100 alerts) | \~1,570 | \~15,700 | 100,000 | \~16% |
| DO duration (2 objects x 3,600 s x 0.125 GB) | 900 GB-s | 9,000 GB-s | 13,000 GB-s | \~69% |
| Worker requests (REST calls, socket upgrades, usage polls) | \~50 | \~500 | 100,000 | <1% |
| Workers AI on `@cf/meta/llama-3.2-3b-instruct` (200 explanations at \~5 neurons, 30 briefings at \~17) | n/a | \~1,500 neurons | 10,000 neurons | \~15% |

Neuron estimates use Cloudflare's published rates for that model (4,625 neurons per million input tokens, 30,475 per million output tokens) with about 600 input and 60 output tokens per explanation and 2,000 in / 250 out per briefing.

### Levers if a limit gets tight

1. Sweep at 9.6 s for en route-only sessions (halves alarms, writes and RPC calls).
2. Merge the SafetyNet DO's input into the alarm path with one batched RPC per two sweeps (independence kept at the code and socket level).
3. Lower the idle auto-pause from 10 to 3 minutes.
4. Move to Workers Paid ($5 per month minimum) when demos outgrow the free tier; the code does not change.

## 9. Build plan

One engineer working part-time with Claude Code can reach a demo in about 8 weeks; each milestone ends only when its named scenarios pass.

&#91;embedded content: SKYWARD Lite build plan · 5 milestones over 8 weeks, each closed by a scenario gate\]

The spec and this plan go into `specs/` first, so each milestone can be handed to Claude Code as a bounded task with its scenarios as the acceptance test.

### Week 1 tasks (start here)

- [ ] Create the repo with the layout from section 3; commit both spec documents to `specs/`.
- [ ] Write `wrangler.jsonc` with the Worker, static assets and the three SQLite-backed Durable Object classes.
- [ ] Implement `src/shared/types.ts` from section 7.
- [ ] Build the Airspace DO alarm loop with pause on zero connected sockets.
- [ ] Implement the sim world and pilot model for scenario 1 only.
- [ ] Draw targets and data blocks on the console canvas from `sweep` messages.
- [ ] Deploy with `wrangler deploy` and confirm `/api/usage` reports today's consumption.

## 10. Test scenarios and acceptance criteria

The prototype is done when all ten scenarios pass headless in CI (scripted controller) and live with a human at the console.

| # | Scenario | Setup | Pass criteria |
| --- | --- | --- | --- |
| 1 | Head-on en route conflict | Two jets opposite direction, same altitude, CTR-NW | Advisory at least 5 min before loss of separation; accepted resolution keeps 5 NM / 1,000 ft |
| 2 | Crossing conflict, one climbing | Departure climbing through an overflight | Altitude or vector resolution shown; no secondary conflict created |
| 3 | Agents off, conflict alert on | Scenario 1 with Separation agent switched off | No advisory; SafetyNet DO conflict alert at about 2 min, every time |
| 4 | Arrival surge | Surge preset, 70 aircraft/hour, 2 runways | Sequencer keeps wake spacing; average runway time error under 30 s |
| 5 | Terrain | Arrival descending early toward high terrain grid cell | MSAW alert within one sweep |
| 6 | Runway incursion | Departure cleared onto runway with arrival on 2 NM final | Runway alert within one sweep of conflicting clearance |
| 7 | Emergency | Aircraft squawks 7700 and requests descent | Highlighted on all consoles; agents reprioritize within 5 s |
| 8 | Lost comms | Aircraft squawks 7600 | Flight continues on last clearance; other traffic advised around it |
| 9 | Wrong readback | Pilot model reads back wrong altitude | Readback mismatch alert before the aircraft reaches the wrong altitude |
| 10 | Multiplayer handoff | Two humans on CTR-NW and APP | Handoff proposed, accepted by receiver, ownership moves; both consoles agree within one sweep |

### Non-functional acceptance

- **Safety Monitor**: 0 unsafe advisories reach a console across 1,000 randomized fast-time runs (sim at max speed, headless).
- **Replay**: any session replays to identical state from its event log and seed.
- **Budget**: 10 session-hours in one day stay under 80% of every free-tier limit, verified with `/api/usage`.
- **Latency**: sweep message reaches consoles under 300 ms after the alarm fires (measured in browser).

## 11. Known limits, risks and path to the real system

SKYWARD Lite validates the architecture and the human-agent interaction, not the safety case; everything it proves must be re-proven on certified infrastructure before any real use.

### Known limits

| Limit | Consequence | Mitigation in the prototype |
| --- | --- | --- |
| Free-tier duration ceiling (\~14 session-hours / day) | Not an always-on demo | Auto-pause; governor; sessions on demand |
| Agents co-hosted in one Durable Object | One crash takes down all planning agents at once | Agent isolation via try/catch per actor; the SafetyNet DO stays independent; each actor's interface is ready to move into its own DO on a paid plan |
| 4.8 s sweep, no interpolation | Coarser than ADS-B's \~1 s | Matches terminal radar; good enough to exercise every agent |
| Flat-earth, simple aircraft performance | Trajectory errors grow beyond about 100 NM | Airspace limited to that radius |
| Fictionalized airspace | Not usable for real-procedure training | Clearly labeled on every screen |
| Fast-time testing | Running 1,000 randomized runs on Cloudflare would burn the budget | Run them locally in Vitest with Miniflare; deploy only for live sessions |

### Risks to the build

- **Free-tier terms change**: limits above are as of this plan; the usage endpoint and governor read thresholds from config so they can be updated without code changes.
- **Scope creep into realism**: keep the 10 scenarios as the definition of done; new realism goes on a v2 list.
- **Misrepresentation**: the console carries a permanent "SIMULATION, NOT FOR OPERATIONAL USE" banner, and the README states the same.

### What carries over to the real SKYWARD

1. The agent contracts (Advisory, Alert, BusEvent) and the precedence order, unchanged.
2. The Safety Monitor plus Arbiter pipeline and the independent safety-net path.
3. The console interaction model: max 3 advisories, one-action accept, coded reject reasons, expiry.
4. The event-sourced audit and replay design.
5. Scenario library and acceptance tests, as the seed of a much larger fast-time validation suite.

What does not carry over: Cloudflare as the runtime (a certified system runs on FAA-controlled, isolated infrastructure), the simulated sensors, and the simplified separation logic, which must be replaced by formally verified algorithms.
