# ClaimAR 3.0 Specification — Polygonal Multiplayer

> **Status: DESIGN APPROVED, implementation not started.**
> This document is the **what** — functionality, rules, visuals, UX, constraints.
> [`V3_IMPLEMENTATION.md`](./V3_IMPLEMENTATION.md) is the **how** — architecture, schema, pipelines, migration phases, and the progress tracker.
> Both documents are self-contained: a fresh working session should be able to execute from these two files plus `CLAUDE.md` (which describes 2.0 as-built) without any prior conversation context.

| Version | System | Status |
|---|---|---|
| 1.0 | Grid, single-player (`GridClaimer` era) | Superseded; code is dead, deleted in Phase 0 |
| 2.0 | Grid, multiplayer (per-cell cloud store) | **Shipping** — published as ClaimAR; documented in `CLAUDE.md` |
| 3.0 | **Fine-grid core, polygonal rendering, multiplayer** | This spec |

Decisions in this spec were made 2026-08-12 after a three-track design study (genre/algorithm survey, Lens Studio & Spectacles platform-limit research against official docs, line-level codebase seam map). Key research facts are frozen into `V3_IMPLEMENTATION.md` §9 so they never need re-deriving.

---

## 1. Product definition

Same game, continuous world. Players physically walk to draw a trail, loop back to their own territory to capture the enclosed area, and die when someone (including themselves) crosses their trail. 3.0 replaces the visible 2-meter blocks with smooth polygonal territory — while keeping a discrete grid as the authoritative game core, at a much finer resolution.

**What the player sees change in 3.0:**
- Territory is a smooth curved shape bounded by a continuous translucent wall (the cube look, made continuous), with a faint tinted floor fill.
- Their trail is a smooth ribbon-wall tracing the path they *actually walked* (not cell blocks), with the familiar pillars planted along it.
- A much larger scrolling minimap (~24–32 m window vs. today's 10 m) showing everyone's territory shapes.
- A territory-percentage score readout.
- A kill feed announcing eliminations by display name.

**What deliberately does not change (parity guarantees):** all 2.0 rules and multiplayer behavior — kill-on-trail, self-collision death, out-of-bounds death, 3-second respawn with the blocked-spawn rules, leave-equals-death cleanup, rejoin behavior, the 5-color slot system with the 6th-player fallback, colocated session model, and all publication guard rails.

**Explicit non-goals for 3.0** (deferred, not rejected): onboarding/safety screen and submission-metadata work; leaderboard beyond territory %; solo mode; player cap enforcement / spectator mode; server authority; cross-version session compatibility (3.0 clients cannot share a session with 2.0 clients — the sync schema is different; bump the lens version).

---

## 2. Design pillars (the decided envelope)

1. **Fine grid core, polygon look.** The grid stays authoritative for all rules (staking, capture, kills, bounds). Only rendering becomes polygonal. Target cell size **0.5 m** (160×160 over the arena), fallback **1 m** — final value chosen by the Phase 1 on-device benchmarks. Cell size is a single constant; no design element depends on its value.
2. **Cubes/pillars aesthetic, adapted.** Translucent boundary wall band at roughly cube height + faint ground fill + trail ribbon-wall + existing pillar prefabs along the trail.
3. **Owner-writes-own sync schema.** Each player's device is the only writer of that player's synced state (territory mask, trail, position, capture counter). Write conflicts are eliminated by construction. Full redesign of the 2.0 per-cell store.
4. **Render-target minimap.** A dedicated orthographic camera renders the territory meshes top-down into a small texture. The minimap window is a camera parameter, not a data structure.
5. **Synced data, local views.** Nothing visual travels over the network. Meshes, pillars, minimap, feed, and score are all rebuilt locally from synced data on every client. Territory disappears because its data cleared — never because a networked object was destroyed.

---

## 3. Game rules (authoritative spec)

Terminology: a player's **territory** is the set of grid cells in their claimed mask. A player's **trail** is the ordered path they have walked since leaving their territory, represented both as raw world-space points (for rendering/sync) and as the set of grid cells it covers (for rules).

### 3.1 Movement & staking
- R1. Position is sampled at 10 Hz from the device tracker (unchanged from 2.0).
- R2. When an alive player occupies a cell **not in their own territory**, that cell joins their trail. Consecutive samples are Bresenham-densified so fast movement cannot skip cells (2.0 rule, kept — it matters *more* at fine resolution).
- R3. Trails may cross enemy **territory** freely (drawing trail over it); entering enemy territory is not itself lethal (2.0 parity).

### 3.2 Capture
- R4. When an alive player with a non-empty trail enters a cell of **their own territory**, the loop closes: the trail cells plus the enclosed interior (exterior flood-fill algorithm, 2.0's `findAndFillEnclosedRegion` semantics at the new resolution) are added to their territory.
- R5. Captured cells are **carved from every other player's territory** (2.0 parity: conversion overwrites enemy claims).
- R6. Enemy **trails** passing through a captured region are unaffected (2.0 parity: per-component semantics — structural in 3.0, since trails and territory are separate data).
- R7. A live enemy standing inside the captured region is **not** killed by the capture, and their cells are captured anyway (2.0 parity). *(Open question OQ-1 tracks the splix-style fairness alternative: skip cells under a live player. Default: parity.)*
- R8. Capture is atomic from the capturing player's perspective: one mask update, one capture event. The 2.0 sequential 40/50 ms per-cell write chains are gone by design.

### 3.3 Kills & death
- R9. An alive player whose movement (Bresenham-densified) touches a cell of a **present** enemy's trail kills that enemy. Fires the death event; the enemy dies on all clients (2.0 parity).
- R10. **Ghost trails are claimable, not lethal** (2.0 parity, rule F5): a trail whose owner is not present in the session doesn't kill; it is treated as stale and cleared.
- R11. **Self-collision kills** (2.0 parity — intended Paper.io mechanic), with a **new grace window**: the most recent `GRACE_TRAIL_S` seconds of one's own trail (≈ the last 5–6 cells at walking speed and 0.5 m cells) cannot self-kill. Mandatory at fine resolution — without it, 10 Hz sampling jitter across a just-left cell edge kills the player spuriously. 2.0's 2 m cells provided this protection implicitly.
- R12. **Out-of-bounds kills** (2.0 parity): leaving the 80×80 m arena while alive is fatal.
- R13. On death: the victim's territory, trail, and visuals are removed on every client; their color slot is freed; respawn countdown begins (2.0 parity, including all ghost-write interception guarantees).
- R14. **Leave = death** (2.0 parity): a departing player is cleaned up on every remaining client, including territory data no client is currently near.

### 3.4 Respawn & spawning
- R15. 3-second respawn countdown (shared `RESPAWN_FLOOR_S = 3.0`), frozen with an explanatory message while the player stands on illegal ground (2.0 parity: "Move to open ground" / "Return to the play area").
- R16. **Home claim is a disc, not a cell**: on first spawn and respawn, the player receives a seed territory disc of `HOME_CLAIM_DIAMETER_M` (~3 m) centered on their position. Spawn legality = every cell of the disc is in-bounds and free of any territory or trail. If illegal, the claim defers until the player reaches open ground (2.0's deferral semantics, applied to the disc).
- R17. All 2.0 timing invariants hold, most critically: the ghost-interception TTL (`RECENTLY_DEAD_TTL_MS = 2000`) **must stay below** the respawn floor, or respawned home claims get eaten. The 2.0 `onAwake()` clamp carries over.

### 3.5 Identity & color
- R18. clientID = FNV-1a hash of display name (unchanged, byte-identical in both files that implement it). playerID/visual color via the 5-slot system with rejoin reuse and the 6th-player local-only fallback (unchanged).

---

## 4. New features

### 4.1 Territory score (%)
- S1. Each player's score = (cells in their mask) / (total arena cells), as a percentage with one decimal (e.g., `12.4%`).
- S2. Displayed as a ranked list of up to 5 entries near the minimap, each row tinted with the player's claim color; the local player's row is visually distinguished. Dead players show their pre-death 0% (mask is cleared on death).
- S3. Updates are event-driven (on any mask change), never per-tick. Counting is a popcount over the changed player's mask — trivial in the 3.0 schema (it was O(subscribed cells) per player in 2.0, which is why it was deferred).

### 4.2 Kill feed
- K1. A screen-space feed of the last 3 death events, newest on top, each fading out after ~4 s.
- K2. Message forms: `{killer} eliminated {victim}` (trail kill), `{victim} crossed their own trail` (self-collision), `{victim} left the arena` (out-of-bounds), `{victim} left the game` (session leave).
- K3. Requires disambiguating death causes — 2.0's payload cannot (self-kill, out-of-bounds, and leave all look like `killerID === deadPlayerID`; known limitation FEAT-3). The 3.0 death event carries an explicit cause code (see `V3_IMPLEMENTATION.md` §1.6). Leave entries are synthesized locally from the session-leave handler (no RPC involved, 2.0 parity).
- K4. Names come from a local clientID → displayName map maintained by the presence handlers. If a name is unknown (edge: event about a player seen by hash only), fall back to `Player {visualID}`.

### 4.3 Larger minimap
- M1. North-up, player-centered window of `MINIMAP_WINDOW_M` (default 28 m; tunable 24–32 m), rendered from the real territory meshes — shapes on the map are pixel-consistent with the world.
- M2. Smooth continuous scrolling (the camera follows the player's continuous position — no cell-snap).
- M3. Shows: all territory fills, all trails, remote player dots (colored by visual ID, from each player's synced position), the local player as the existing center arrow (rotation-only — the 2.0 sub-cell slide machinery is retired), and out-of-bounds areas in gray with a visible arena border.

---

## 5. Visual specification

### 5.1 Territory (per player)
- **Ground fill**: flat mesh of the smoothed territory polygon(s), claim color, low alpha (~0.2), double-sided, y-offset per player index (z-fighting), sitting at floor level (device Y minus eye-height offset convention carried from 2.0).
- **Boundary wall**: the smoothed outline extruded vertically to `WALL_HEIGHT_M` (default 2.0 m — matches the 2.0 cube scale), translucent claim material (the current cube alpha look). Walls exist on every ring, including hole boundaries.
- **Smoothing contract**: outline = marching squares over the mask → simplification (tolerance 0.3–0.5 cells) → Chaikin corner-cutting ×2. Chaikin's deviation is mathematically bounded (≤ ~0.18 cells at a right angle), so **the rendered boundary never strays more than ~a fifth of a cell from the true ownership boundary** — the picture cannot lie about the rules by more than 10 cm at 0.5 m cells.
- Holes and disjoint islands render correctly (the contour pipeline emits polygons-with-holes natively).

### 5.2 Trail (per player)
- **Ribbon-wall**: a smooth thick ribbon following the player's raw walked positions (own trail: local 10 Hz samples; remote trails: synced points, spline-interpolated), width `TRAIL_WIDTH_M` (default = cell size), extruded to stake-cube height, stake material (translucent).
- **Pillars**: the existing P{n}StakePillar prefabs, locally instantiated every `PILLAR_SPACING_M` (~2 m) of arc length along the ribbon. This preserves the game's most recognizable visual element.
- Trail visuals clear on capture (converted region animates in as territory) and on death.

### 5.3 Materials & shaders
- Reuse the existing 15 P1–P5 materials/colors. Two required changes:
  - Claim materials: `CullMode: Back → None` (ground fills must be visible from all angles).
  - **Author flat/unlit variants of the claim shaders for the large meshes.** The current claim shaders are full PBR (texture/normal/BRDF); Spectacles guidance says avoid PBR, and territory fills/walls are the largest surfaces in the game. Stake/pillar shaders are already flat color — no change.
- Minimap colors derive from the same `getPlayerClaimColor`/`getPlayerStakeColor` tables automatically (the map renders the real materials).

### 5.4 Capture animation (optional within 3.0)
- Newly captured area fades/sweeps in over ~0.5 s rather than popping. The capture event carries the exact region, so this is a rendering-only concern. Ship 3.0 without it if schedule demands; it is the single highest-value polish item (OQ-2).

---

## 6. Tunables

All in one constants module (`V3Config`), no magic numbers in logic code:

| Constant | Default | Notes |
|---|---|---|
| `ARENA_M` | 80 | **Decided: keep 80×80 m.** Revisit only if Phase 1 measures unacceptable colocation drift at range |
| `CELL_SIZE_M` | 0.5 target / 1.0 fallback | Phase 1 decides; early phases run at 2.0 unchanged |
| `GRID_N` | `ARENA_M / CELL_SIZE_M` | 160 at target |
| `HOME_CLAIM_DIAMETER_M` | 3.0 | Spawn disc (R16) |
| `GRACE_TRAIL_S` | 1.5 | Self-collision grace window (R11) |
| `TRAIL_SYNC_HZ` | 3 | Trail array write throttle |
| `POS_SYNC_HZ` | 2 | Position property write throttle |
| `WALL_HEIGHT_M` | 2.0 | Territory boundary wall |
| `TRAIL_WIDTH_M` | = `CELL_SIZE_M` | Ribbon width |
| `PILLAR_SPACING_M` | 2.0 | Pillar cadence along trail |
| `MINIMAP_WINDOW_M` | 28 | Ortho camera size |
| `MINIMAP_RT_PX` | 256 | Render target resolution |
| `SIMPLIFY_TOL_CELLS` | 0.4 | Outline simplification tolerance |
| `CHAIKIN_ITERS` | 2 | Outline smoothing iterations |
| `RESPAWN_FLOOR_S` | 3.0 | Unchanged from 2.0 |
| `RECENTLY_DEAD_TTL_MS` | 2000 | Unchanged; invariant: `< RESPAWN_FLOOR_S × 1000` (clamped at startup) |

---

## 7. Hard constraints (platform & publication)

| Constraint | Value | Source |
|---|---|---|
| Network message size | 100 KB max | Official (Sync Kit payload & rate limits) |
| Network message rate | 250 per 5 s design budget (350 documented on the newer page; design to the lower) | Official |
| Store total size | ~1 MB (semi-verified); `getMaxSizeInBytes()` measured in Phase 1 | Snap support FAQ |
| StorageProperty batching | All property writes in one frame = one message | Official |
| Mesh index format | UInt16 only → 65,536 vertices per mesh | Official API |
| Render budget | ~16 ms/frame (60 FPS target on Spectacles) | Official perf overlay docs |
| Textures | ≤512 px recommended; avoid PBR; minimize draw calls | Official Spectacles guidance |
| JS runtime | ES2019, CommonJS, typed arrays available; engine unnamed — **assume no JIT until Phase 1 measures** | Official (language level); engine unverified |
| No npm/WASM at runtime | Libraries vendored as plain TS/JS source only | Platform |
| Licenses | Vendored code must be permissive (ISC/BSD/MIT). **The `marchingsquares` npm package is AGPL — do not vendor it** | License audit |

**Publication guard rails (unchanged, load-bearing):** never `require()` `ProcessedLocationModule`/`RawLocationModule`; never assign a `LocationAsset` to a `LocatedAtComponent`; `SessionController.locatedAtComponent` stays assigned while `ColocatedWorld`'s `Location` field stays empty; re-run the audit checklist in `CLAUDE.md` (Lens Publication section) before any resubmission. Nothing in 3.0 touches location APIs.

---

## 8. Acceptance criteria

3.0 is done when, in a multi-device playtest:

1. **Parity**: every rule in §3 is demonstrated — stake, capture with interior fill (including a capture containing an enemy island), trail kill, self-collision kill (and grace window non-kill), out-of-bounds death, respawn with blocked-spawn messaging, home-claim disc deferral on occupied ground, leave cleanup on all clients, rejoin with color reuse, ghost-trail claim.
2. **Look**: territory renders as smooth filled shapes with continuous walls; trails are smooth ribbons with pillars; no visible popping between rule state and rendered state beyond one 10 Hz tick + smoothing bound.
3. **New features**: score list ranks correctly and updates on capture/death; kill feed reports all four cause types with correct names; minimap shows the larger window with all players' shapes, dots, and the arena border.
4. **Performance**: sustained ~60 FPS on device during normal play; capture of a large region causes no visible hitch (rebuild sliced if needed); no rate-limit errors in the logger during a 15-minute 3+ player session.
5. **Robustness**: kill/leave/rejoin storms (the 2.0 ghost-machinery test scenarios) leave no orphaned visuals, no stale territory, no color leaks — verified per the existing KNOWN_ISSUES regression scenarios.

---

## 9. Open questions log

| ID | Question | Default until decided |
|---|---|---|
| OQ-1 | Fairness: skip capturing cells under a live enemy (splix rule) or capture regardless? | Capture regardless (2.0 parity) |
| OQ-2 | Capture animation in 3.0 or first patch? | In 3.0 if schedule allows |
| OQ-3 | Final `CELL_SIZE_M` (0.5 vs 1.0) | Phase 1 benchmark decides |
| OQ-4 | Final `MINIMAP_WINDOW_M` (24–32) | 28; playtest feel |
| OQ-5 | Do trails render for players standing inside their own territory (zero-length trail)? | No trail shown (2.0 parity: no stakes while home) |
