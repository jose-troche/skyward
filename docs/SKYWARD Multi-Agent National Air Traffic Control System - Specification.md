# SKYWARD: Multi-Agent National Air Traffic Control System — Specification

Oct 2, 2026 · @Jose

## 1. Purpose and scope

SKYWARD is a multi-agent automation layer for the US National Airspace System (NAS) that roughly doubles controller capacity per sector while legal separation authority stays with certified FAA controllers. It augments, then progressively replaces, decision functions in today's ERAM, STARS, TFMS and ASDE-X stack; it never removes the human from the clearance loop for a function until that function is individually certified.

Scale it must carry (approximate figures): about 45,000 flights per day, 5,000+ aircraft airborne at peak, 20 en route centers (ARTCCs), roughly 150 TRACONs and 500+ towers.

### What "real" means here

- **Live NAS data**: consumes production surveillance and flight data through FAA SWIM and facility feeds, not a simulation.
- **Certified software**: developed and assured under RTCA DO-278A (ground CNS/ATM software), with the highest-criticality functions at Assurance Level 1-2.
- **FAA Safety Management System**: every capability passes Safety Risk Management (SRM) before it touches live traffic, per FAA Order JO 1000.37 and the ATO SMS Manual.
- **Human authority**: controllers issue or approve every clearance. Agents propose; humans dispose.

### In scope

- En route, terminal, tower/surface, oceanic and national flow management decision support.
- Conflict probe, sequencing, metering, reroutes, handoff automation, datalink clearance drafting, workload balancing.
- Controller console integration (STARS/ERAM displays and a new SKYWARD advisory pane).

### Out of scope

- Replacing radar, ADS-B ground stations, radios or navaids.
- Military airspace control and air defense (NORAD) functions, beyond data exchange.
- Any agent issuing a clearance to an aircraft without human approval (until a later, separately certified phase).

### Design principles

1. **Deterministic safety core**: separation assurance and safety nets are deterministic, verifiable algorithms. LLMs never sit in the separation-critical path.
2. **Independence**: safety nets (conflict alert, MSAW, runway safety) run on separate code, hardware and data paths from the planning agents.
3. **Propose, don't impose**: agents output ranked, explained advisories with an expiry time; a human accepts, edits or rejects.
4. **Fail to today**: any SKYWARD failure degrades to current-day ATC procedures with no loss of surveillance or voice.
5. **Explainable**: every advisory carries its inputs, rule or model version, and predicted outcome, logged for audit and incident replay.

## 2. Operational concept

SKYWARD mirrors the NAS's existing facility hierarchy: one agent tier per facility layer, each working a nested time horizon, so that strategic plans from above become constraints for the tactical agents below.

| Facility layer | Today's system | SKYWARD agent tier | Planning horizon | Human counterpart |
| --- | --- | --- | --- | --- |
| ATCSCC (Command Center, Warrenton VA) | TFMS, traffic management initiatives | National Flow Agent | 2-12 hours | National Traffic Management Officer |
| ARTCC (20 centers) | ERAM | En Route Sector Agents + Center Flow Agent | 20 min - 2 hours | Radar (R-side) and data (D-side) controllers, TMU |
| TRACON (\~150) | STARS | Terminal Sequencing Agents | 5-40 min | Approach and departure controllers |
| ATCT (500+ towers) | ASDE-X / ASSC, TFDM | Surface and Runway Agents | 0-20 min | Local, ground and clearance delivery controllers |
| Oceanic (New York, Oakland, Anchorage) | ATOP | Oceanic Agent | 30 min - 6 hours | Oceanic controllers |

### Operating modes

1. **Shadow mode**: agents run on live data, produce advisories that only analysts see; outcomes are scored against what controllers actually did.
2. **Advisory mode**: advisories appear on the controller's console; the controller accepts, edits or rejects each one.
3. **Supervised automation**: for certified low-risk functions (handoffs, frequency changes, routine datalink clearances), the agent executes after a configurable silent-consent window unless the controller vetoes.
4. **Contingency mode**: on facility outage (the 2014 Chicago Center fire is the reference case), surviving centers' agents absorb the dead airspace's traffic picture and propose redistribution.

### A day in the life of one flight

1. The airline files a plan; the National Flow Agent checks it against forecast demand and weather, and may assign an Expect Departure Clearance Time.
2. The Surface Agent at the departure airport sequences pushback and taxi to hit that time and the runway's departure slot.
3. The Terminal Agent merges the climb-out into departure flows; the En Route Sector Agents conflict-probe the route and hand the flight sector to sector.
4. Near the destination, the Center Flow Agent meters arrivals (time-based flow management), and the Terminal Agent builds the final sequence and spacing.
5. At every step a human controller owns the aircraft; agents draft clearances and handoffs for that controller.

## 3. Multi-agent architecture

SKYWARD runs 15 cooperating agents in three layers: foundation agents build one shared world model, planning agents propose actions against it, and a verified Safety Monitor plus an Arbiter filter every proposal before a controller sees it.

&#91;embedded content: SKYWARD agent architecture · 15 agents, 1 verified monitor, independent safety nets\]

Safety nets read raw surveillance on their own path, so a fault anywhere in the agent stack cannot suppress a conflict or terrain alert.

### Agent roster

| Agent | Layer | Responsibility | Key inputs | Outputs | Technique | Max authority |
| --- | --- | --- | --- | --- | --- | --- |
| Track Fusion | Foundation | One fused track per aircraft; spoofing detection | ADS-B, radar, multilateration | Tracks with accuracy flags | Multi-sensor tracker (IMM Kalman filter) | 0 |
| Flight Data | Foundation | Correlate tracks to plans; maintain cleared intent | SFDPS, controller entries | Flight objects | Deterministic rules | 0 |
| Trajectory | Foundation | 4D prediction, 20 min ahead | Tracks, intent, winds, performance models | Predicted trajectories with error bounds | Physics model + bounded ML correction | 0 |
| Weather | Foundation | Turn forecasts into hazard polygons over time | ITWS, NEXRAD, NWS, PIREPs | No-go and caution volumes | Nowcast models | 0 |
| Airspace | Foundation | Live airspace status | NOTAMs, TFRs, SUA schedules, adaptation data | Active constraints | Deterministic rules; LLM-assisted NOTAM parsing with validator | 0 |
| Audit | Foundation | Record and replay everything | All bus traffic | Immutable log | Append-only store | 0 |
| National Flow | Planning | Balance national demand and capacity 2-12 h out | TFMS demand, weather, airport rates | Proposed TMIs, reroutes, ground delay programs | Optimization (MILP) | 1 |
| Center Flow | Planning | Time-based metering into busy airports | Trajectories, airport rates | Meter-fix times, speed advisories | Scheduler | 1 |
| Sector Agent (one per sector) | Planning | Owns flights with its controller; drafts handoffs and clearances | All agents' proposals for its flights | Per-position advisory list | Coordination logic | 2 |
| Separation Assurance | Planning | Detect conflicts 20 min out; propose resolutions | Trajectories, airspace, weather | Ranked resolutions | Geometric probe + search | 1 |
| Terminal Sequencer | Planning | Arrival and departure order and spacing | Center Flow times, runway config, wake categories | Sequence, vectors, speeds | Constraint solver | 1 |
| Surface | Planning | Pushback, taxi and runway slot plans | ASDE-X, departure slots, gate data | Pushback times, taxi routes | Scheduler | 1 |
| Oceanic | Planning | Procedural separation on oceanic tracks | ATOP, ADS-C reports | Clearance proposals | Deterministic rules | 1 |
| Workload | Planning | Predict position workload; propose splits | Traffic forecast, staffing | Split or combine recommendations | ML regression | 1 |
| Datalink | Planning | Draft CPDLC uplinks; check voice readbacks | Accepted advisories, voice transcripts | Uplink drafts, mismatch alerts | Templates + speech recognition | 2 |

The Safety Monitor and Arbiter are infrastructure, not agents: they cannot originate an action, only pass, drop or merge proposals.

## 4. Coordination, authority and handoff protocol

Every flight has exactly one owning human controller and one owning Sector Agent at all times; all other agents may only send proposals to that owner, never act on the flight directly.

### Shared world model

- A single fused **Trajectory Store** holds each flight's track, intent (flight plan, cleared altitude, assigned speed) and 4D predicted trajectory. Agents read it; only the Surveillance Fusion and Flight Data agents write it.
- Agents publish proposals to an **Advisory Bus**. The **Arbiter** deduplicates, resolves conflicts between agents' proposals, and delivers one coherent advisory set per controller position.
- All bus traffic is append-only and time-stamped to the millisecond for replay.

### Precedence when proposals conflict

1. Safety-net alerts (conflict alert, MSAW, runway incursion) override everything and are never filtered by the Arbiter.
2. Separation-assurance resolutions.
3. Explicit controller instructions already issued.
4. Pilot requests and emergencies (an aircraft squawking 7700 gets priority handling across all agents).
5. Flow constraints (metering times, miles-in-trail, ground delay programs).
6. Efficiency (direct routes, optimal altitudes, fuel).

### Authority levels

| Level | Name | Agent may | Example functions | Certification gate |
| --- | --- | --- | --- | --- |
| 0 | Inform | Display data and predictions | Workload forecast, weather impact | Shadow-mode validation |
| 1 | Advise | Propose an action; human must accept | Conflict resolution, reroute, sequence | SRM + DO-278A AL3 |
| 2 | Silent consent | Execute after a veto window (default 10 s) | Handoffs, frequency transfers, routine CPDLC altimeter or route amendments | SRM + AL2, 12 months at Level 1 |
| 3 | Autonomous | Execute, notify human | Future: low-density night en route sectors | Rulemaking + AL1; not in initial program |

### Advisory contract

Every advisory carries: id, flight ids, proposed action, plain-language rationale, predicted effect (minimum separation, delay change), confidence, expiry time, authority level, source agent and model version. An expired advisory disappears from the console automatically.

### Handoff protocol (sector to sector)

1. The owning Sector Agent predicts boundary crossing and drafts the handoff about 3-5 minutes out.
2. The receiving Sector Agent probes the flight against its traffic and either pre-accepts or proposes conditions (altitude, speed, reroute).
3. Both human controllers see the proposed handoff; the receiving controller accepts (automatically under Level 2).
4. The transferring agent drafts the frequency change; the controller transmits it by voice or CPDLC.
5. Track ownership moves in the Trajectory Store on first contact with the new controller.

### Agent-to-agent negotiation

Cross-boundary requests (an en route agent asking a terminal agent for an arrival slot) use a contract-net pattern: request, bids with cost, award, commit. A commitment is a constraint other agents must honor until its owner releases it or a human overrides it.

## 5. Data sources and external interfaces

SKYWARD reads existing NAS feeds through FAA SWIM and facility-level interfaces; it adds no new sensors. Update rates below are typical values.

### Inbound

| Source | Provides | Typical update | Access path | Main consumers |
| --- | --- | --- | --- | --- |
| ADS-B (1090ES / UAT) via FAA surveillance broadcast services | Aircraft-reported position, velocity, identity, intent | \~1 s | Facility feed; SWIM for aggregate | Surveillance Fusion |
| Terminal radar (ASR-9 / ASR-11) | Primary and secondary returns | \~4.8 s | STARS track data | Surveillance Fusion |
| En route radar (ARSR / CARSR) | Long-range returns | \~12 s | ERAM track data | Surveillance Fusion |
| Airport surface surveillance (ASDE-X / ASSC) | Surface targets incl. vehicles | \~1 s | STDDS via SWIM | Surface Agent, Runway Safety Net |
| Flight data (ERAM / SFDPS) | Filed and amended flight plans, cleared altitudes | Event-driven | SWIM SFDPS | Flight Data Agent |
| Traffic flow (TFMS / TFMData) | Demand, TMIs, ground delay programs | 1-5 min | SWIM TFMData | National and Center Flow agents |
| Weather (ITWS, NEXRAD, NWS forecasts, PIREPs) | Convection, winds aloft, ceilings | 1-5 min | SWIM weather services | Weather Agent |
| NOTAMs and airspace status | Closures, TFRs, special use airspace activation | Event-driven | FAA NOTAM System via SWIM | Airspace Agent |
| Controller voice (VSCS / STVS taps) | Transcripts of clearances and readbacks | Real time | Read-only audio tap, on-prem speech recognition | Readback Monitor |

### Outbound

| Destination | What SKYWARD sends | Notes |
| --- | --- | --- |
| Controller consoles (ERAM, STARS, TFDM displays) | Advisories, alerts, workload indicators | New advisory pane; accept/reject via existing input devices |
| Data Comm (CPDLC) | Drafted clearances for controller release | Never sent without controller release at Levels 0-1 |
| TFMS / ATCSCC tools | Proposed TMIs, reroute packages | Approved by traffic managers |
| Airlines (SWIM, Collaborative Decision Making) | Expected delays, slot offers | Read-only to airlines |
| Audit store | Every input, advisory and decision | Retained per FAA records schedule for incident investigation |

### Interface rules

- All feeds enter through a one-way data diode into the SKYWARD enclave; outbound paths are separately authorized per destination.
- Every message is schema-validated and time-checked; stale or malformed data is quarantined and flagged, never silently used.

## 6. Functional requirements

Each requirement is testable and owned by one agent; "shall" items are mandatory for the agent's first certified release.

| ID | Requirement | Owner agent | Authority level |
| --- | --- | --- | --- |
| FR-SUR-01 | The system shall fuse ADS-B, radar and multilateration into one track per aircraft with position error under 0.1 NM (terminal) and 0.3 NM (en route), 95th percentile. | Surveillance Fusion | 0 |
| FR-SUR-02 | The system shall flag ADS-B reports that disagree with radar by more than 1 NM as possible spoofing within 2 update cycles. | Surveillance Fusion | 0 |
| FR-FDP-01 | The system shall correlate every track with its flight plan or mark it as an uncorrelated target within 10 s of acquisition. | Flight Data | 0 |
| FR-TRJ-01 | The system shall predict each flight's 4D trajectory 20 min ahead, using wind, aircraft performance (BADA-class models) and cleared intent, refreshed on every surveillance update. | Trajectory | 0 |
| FR-SEP-01 | The system shall probe all pairs for loss of separation (5 NM / 1,000 ft en route; 3 NM / 1,000 ft terminal) over a 20-min horizon. | Separation Assurance | 1 |
| FR-SEP-02 | For each predicted conflict the system shall propose at least two ranked resolutions (vector, altitude, speed) with predicted minimum separation and delay. | Separation Assurance | 1 |
| FR-SEP-03 | Resolutions shall be re-checked against all other traffic and active airspace before display (no secondary conflicts). | Separation Assurance | 1 |
| FR-SNT-01 | An independent safety net shall alert on short-term conflicts (about 2 min), minimum safe altitude violations and airspace infringements, regardless of SKYWARD agent state. | Safety Net (independent) | 0 (alert) |
| FR-RWY-01 | The system shall alert on runway incursions and conflicting runway clearances within 1 s of detection. | Runway Safety Net | 0 (alert) |
| FR-SEQ-01 | The system shall build arrival sequences honoring RECAT wake categories and runway configuration, and output scheduled times of arrival to meter fixes. | Terminal Sequencing, Center Flow | 1 |
| FR-SEQ-02 | The system shall propose speed and path-stretch advisories to deliver each arrival within 30 s of its scheduled time. | Center Flow | 1 |
| FR-SFC-01 | The system shall sequence pushback and taxi to meet departure slots, minimizing engines-running taxi time. | Surface | 1 |
| FR-HND-01 | The system shall draft sector handoffs 3-5 min before boundary crossing and execute accepted ones per section 4. | Sector agents | 2 |
| FR-FLW-01 | The system shall forecast sector demand vs capacity 2-12 h ahead and propose traffic management initiatives when demand exceeds Monitor Alert Parameter. | National Flow | 1 |
| FR-WX-01 | The system shall convert convective forecasts into time-varying no-go polygons and propose reroutes around them. | Weather, National Flow | 1 |
| FR-ASP-01 | The system shall ingest NOTAMs, TFRs and special use airspace activations within 60 s and apply them to all probes. | Airspace | 0 |
| FR-CPD-01 | The system shall draft CPDLC uplinks for accepted advisories so the controller releases them with one action. | Datalink | 1 / 2 |
| FR-RBK-01 | The system shall compare transcribed pilot readbacks with issued clearances and alert on mismatch within 3 s of the readback. | Readback Monitor | 0 (alert) |
| FR-WKL-01 | The system shall estimate per-position controller workload and recommend sector split or combine 15-30 min in advance. | Workload | 1 |
| FR-EMG-01 | On emergency squawk (7700), lost comms (7600) or hijack (7500), the system shall highlight the flight on every relevant console and recompute affected plans within 5 s. | All agents | 0 / 1 |
| FR-AUD-01 | The system shall record every input, advisory, controller action and outcome, replayable to the second. | Audit | 0 |

## 7. Non-functional requirements

Safety-critical paths are held to sub-second latency and "seven nines" class availability; planning agents can be slower and less available because the controller can always work without them.

| Category | Requirement | Applies to |
| --- | --- | --- |
| Latency | Surveillance-to-display under 1 s; safety-net alert under 1 s from triggering update | Fusion, safety nets |
| Latency | Conflict probe and resolution set under 2 s after each track update | Separation Assurance |
| Latency | Flow and sequencing replans under 10 s | Flow, Sequencing |
| Availability | 99.99999% for surveillance and safety nets (dual-redundant, hot standby, separate power) | Critical core |
| Availability | 99.999% for advisory agents; loss never affects surveillance or voice | Planning agents |
| Scale | 10,000 simultaneous airborne tracks nationally (2x today's peak), 1,500 per ARTCC | All |
| Scale | 500 controller positions per ARTCC-equivalent deployment | Console layer |
| Determinism | Separation and safety-net outputs bit-for-bit reproducible from logged inputs | Critical core |
| Security | FISMA High; NIST SP 800-53 High baseline; zero-trust segmentation; enclave isolated from internet | All |
| Security | Detect and flag ADS-B spoofing and jamming; never trust an unverified single-source track | Fusion |
| Human factors | Advisory acceptance in 1 action; no more than 3 active advisories per position at once; alerts follow FAA human factors design standard (HF-STD-001) | Console |
| Explainability | Every advisory has a one-line rationale a controller can read in 2 s | All advisory agents |
| Auditability | Complete input and decision log, retained per FAA records schedule, replayable for NTSB investigation | All |
| Maintainability | Adaptation data (airspace, procedures, sector boundaries) updated on the 56-day AIRAC-aligned cycle without code changes | All |
| Model governance | Every ML model versioned, with frozen weights in production, a training-data manifest and a rollback path under 5 min | ML-based agents |

## 8. Safety assurance and certification

SKYWARD earns certification by keeping every learned or generative component outside the separation-critical path and wrapping every agent in a formally verified runtime monitor.

### Runtime assurance (Simplex pattern)

- Each advisory agent is the "advanced controller"; a small, formally verified **Safety Monitor** checks every proposal before it reaches a human.
- The monitor uses well-clear and separation logic of the kind formally verified in NASA's DAIDALUS (PVS proofs); a proposal that violates the separation envelope within the horizon is dropped and logged.
- If an agent produces repeated rejected proposals or misses its latency budget, the monitor suspends that agent and the position reverts to unassisted operation with a console notice.

### Where AI is and is not allowed

| Function class | Technique allowed | Why |
| --- | --- | --- |
| Safety nets, separation probe | Deterministic, formally verified algorithms only | Must be provable and reproducible |
| Trajectory prediction | Physics models, optionally ML-corrected within bounded error envelopes | ML improves accuracy; bounds keep it safe |
| Sequencing, metering, flow | Optimization (MILP, constraint solvers), reinforcement learning in shadow only until certified | Outputs are checked by the Safety Monitor |
| Workload, demand forecasting | ML models | Advisory only (Level 0) |
| Text: rationales, NOTAM summaries, TMU briefings | LLMs, on-premises, frozen versions | Never parsed into clearances; a deterministic validator checks any structured output |

### Certification path

1. **Software assurance**: RTCA DO-278A, Assurance Level 1-2 for the critical core and safety monitor, AL3-4 for advisory agents.
2. **Safety Risk Management**: FAA ATO SMS hazard analysis per capability (functional hazard assessment, then preliminary and system safety assessments).
3. **AI assurance**: follow the FAA Roadmap for AI Safety Assurance and emerging SAE G-34 guidance; document data quality, generalization limits and monitoring.
4. **Human factors**: human-in-the-loop simulation at the FAA William J. Hughes Technical Center with certified controllers before any live advisory.
5. **Operational evaluation**: shadow mode at a key site for at least 6 months, then advisory mode at one facility, then fleet rollout.

### Validation metrics (shadow and advisory modes)

- Zero safety-monitor escapes (an unsafe advisory reaching a console) across all simulations and live hours.
- Conflict detection: missed alerts below 1 per 10 million flight hours; nuisance alerts below 5% of all alerts.
- Controller acceptance rate above 70% for advisories, with rejection reasons coded and fed back.
- Measured workload reduction (NASA-TLX and objective task counts) and throughput change per sector.

## 9. Failure modes and graceful degradation

Every failure ends in a known, rehearsed state no worse than today's ATC; the controller's scope, radios and flight strips never depend on a planning agent.

| Failure | Detection | Automatic response | Controller sees |
| --- | --- | --- | --- |
| One advisory agent crashes or hangs | Heartbeat miss (2 s), latency budget breach | Hot standby takes over; else agent suspended | "Advisories unavailable" banner for that function |
| Agent produces unsafe proposals | Safety Monitor rejections above threshold | Agent quarantined, rolled back to last good version | Banner; no unsafe advisory ever shown |
| Trajectory Store corruption or desync | Cross-check against ERAM/STARS tracks | Freeze advisories; rebuild from raw feeds | Advisories paused, surveillance unaffected |
| Single surveillance source lost (e.g., ADS-B outage) | Feed health monitor | Fusion continues on radar; accuracy flag lowered | Coasting / degraded-accuracy indicators |
| ADS-B spoofing or GPS jamming | Radar-ADS-B disagreement, multilateration check | Suspect tracks downgraded; jammed region marked | Suspect-track symbol, region overlay |
| Whole SKYWARD enclave lost at a facility | Facility monitor | Reverts to legacy ERAM/STARS automation | Standard operations; no agent features |
| Facility outage (fire, power, comms) | Adjacent facilities' monitors | Neighbor agents assemble the traffic picture and propose airspace redistribution | Contingency plan proposal for traffic managers |
| Network partition between facilities | Inter-facility heartbeat | Each side runs locally; handoffs revert to manual coordination | Manual handoff indicator |
| Bad adaptation data (wrong sector boundary) | Pre-deployment validation, runtime sanity checks | Reject new adaptation; keep prior version | None (caught before go-live) |

Degradation drills are mandatory: each facility rehearses "SKYWARD off" operations quarterly so controllers keep unassisted skills current.

## 10. Transition roadmap and open risks

SKYWARD reaches nationwide supervised automation in roughly 10 years, with each phase gated by safety evidence rather than calendar dates; the durations below are planning estimates.

&#91;embedded content: SKYWARD transition roadmap · 4 phases, 4 safety gates (bands not to scale)\]

The first live advisory reaches a controller only after about two years of shadow operation and human-in-the-loop simulation.

### Open risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Controller workforce acceptance | Controllers and their union (NATCA) must trust and co-design the tools | Controllers on every design team; advisory-first; no staffing cuts tied to SKYWARD in early phases |
| Certifying ML components | No settled FAA standard yet for learned models in ATC | Keep ML out of the critical path; Simplex monitor; track FAA AI roadmap and SAE G-34 |
| Legacy integration | ERAM, STARS and TFMS have long, rigid change cycles | Interface through SWIM and display overlays first; deeper integration aligned with the FAA's modernization program |
| Automation complacency and skill decay | Controllers may lose unassisted proficiency | Quarterly "SKYWARD off" drills; acceptance-rate monitoring for rubber-stamping |
| Cyber attack and ADS-B spoofing | A national system is a high-value target | Enclave isolation, data diodes, multi-sensor verification, red-team program |
| Procurement and funding | Multi-year programs drift without stable funding | Modular contracts per agent; each phase delivers standalone value |
| Liability for advisories | Unclear responsibility when a controller follows a bad advisory | Policy decision before Gate 2; complete audit trail of every advisory and action |

### Open questions

- [ ] Which ARTCC hosts the shadow phase (high-density and weather-diverse candidates)?
- [ ] Is Level 2 silent consent acceptable to controllers for handoffs, or only for frequency changes?
- [ ] Who owns adaptation data for agents: facility automation staff or a central team?
