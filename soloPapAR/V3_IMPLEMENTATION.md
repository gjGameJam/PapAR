# ClaimAR 3.0 Implementation Guide

> Companion to [`V3_SPEC.md`](./V3_SPEC.md) (the **what**). This document is the **how**: architecture, sync schema, rendering pipelines, per-file migration plan, phased schedule, and the frozen research facts.
> **This file is the source of truth for implementation progress** — update the tracker below as phases complete, so any fresh session can resume without conversation history.

## Progress tracker

- [x] **Phase 0** — Dead-code purge *(done 2026-08-12: deleted `GridClaimer.ts` + `UnionFindLoopDetection.ts` + metas, `PlayerVisuals` dead minimap methods (`updateMiniMap`/`renderMiniMapCell`/`getCellColor`/`createUICell`/`getCellMatClone`), and both `GridClaimer` imports; zero scene references confirmed by GUID grep; `screenTransform` @input now unused but left wired — scene edit deferred to Phase 3)*
- [ ] **Phase 1** — Experiment day, editor-based (results recorded in §7.1 below)
- [ ] **Phase 2** — Rendering overhaul on the current 2.0 store (2 m cells)
- [ ] **Phase 3** — Render-target minimap
- [ ] **Phase 4** — Sync schema swap + kill feed + score
- [ ] **Phase 5** — Resolution bump + feel pass
- Decisions resolved along the way: *(append here — e.g., "Phase 1: CELL_SIZE_M = 0.5 confirmed, flood fill = X ms")*
  - **2026-08-12 — editor timings are trusted**: hands-on comparison found Lens Studio editor preview and Spectacles hardware performing ~1:1 for this project, so Phase 1 runs in the editor (hardware currently unavailable). Editor numbers are accepted for go/no-go decisions; do a device spot-check + the two-device colocation-drift test (Exp #6) when hardware is back, before locking Phase 5's `CELL_SIZE_M`.

### Resume notes (state as of session end 2026-08-12)

- **Phase 0 exit criterion not yet verified**: "compiles, plays identically" needs the project opened in Lens Studio (no CLI build exists). Grep confirmed zero remaining references to any deleted symbol (`GridClaimer`, `SparseGrid`, `CellState`, `LoopDetection`, `updateMiniMap`, `renderMiniMapCell`, `getCellColor`, `createUICell`, `getCellMatClone`), so failure is unlikely — but open the editor and preview once before starting Phase 1, and check this box when it passes: [ ]
- **Phase 0 changes are uncommitted** on branch `dev` (unless committed since): deleted `GridClaimer.ts`/`UnionFindLoopDetection.ts` + their `.ts.meta`s, edited `PlayerVisuals.ts` (−128 lines) + `LocationTracker.ts` (−1 line), updated `CLAUDE.md`/`KNOWN_ISSUES.md`, and `V3_SPEC.md`/`V3_IMPLEMENTATION.md` are still untracked. `git status` is the authority — if the tree is clean, this note is stale and Phase 0 was committed.
- **Next action**: Phase 1 (§7) in the Lens Studio editor — experiments 1–5; record results in §7.1; decide `CELL_SIZE_M` and minimap A-vs-B (OQ-3). Exp #6 stays deferred until two devices are available.

---

## 0. Architecture overview

**Principle: synced data, local views.** Each device syncs a small set of per-player data keys. Every device independently rebuilds all visuals (world meshes, minimap, score, feed) from that data. No visual object is networked; the SyncKit Instantiator is not used for territory or trails (it is prefab-only by API anyway).

```
                    ┌────────────── per player, owner-device is sole writer ──────────────┐
  local 10 Hz loop  │  mask_<id>      bitpacked territory   (manualIntArray, ~800 ints)   │
  rules on local ──▶│  maskSeq_<id>   capture counter       (manualInt)                   │──▶ all clients:
  grid (masks +     │  trail_<id>     raw walked points     (manualVec2Array, throttled)  │    rebuild local views
  trail rasters)    │  pos_<id>       live position         (manualVec2, throttled)       │    (meshes, minimap,
                    └───────────────────────────────────────────────────────────────────┘     score, feed)
  RPC events (existing SyncEntity channel): playerDeathEvent (now vec4 with cause), captureEvent
  Unchanged: 5 color-slot properties, presence cache, ghost machinery, death RPC plumbing
```

The 2.0 concept map: `stakeList` → trail array; per-cell `(claimedBy, stakedBy)` vec2s → per-player masks + trail rasters; conversion write chains → one mask write + one event; death cell sweep → zero the dead player's four keys.

---

## 1. Sync schema (owner-writes-own)

### 1.1 Keys

| Key | StorageProperty type | Content | Written when |
|---|---|---|---|
| `mask_<clientID>` | `manualIntArray` | Territory bitmask, 32 cells/int, row-major, `GRID_N²/32` ints (800 @ 160²; 3.2 KB) | Home claim, capture, carve, death (zeroed) |
| `maskSeq_<clientID>` | `manualInt` | Monotonic capture counter | Same frame as mask capture writes |
| `trail_<clientID>` | `manualVec2Array` | Raw world XZ points (cm) since leaving own territory | Throttled `TRAIL_SYNC_HZ`; cleared on capture/death |
| `pos_<clientID>` | `manualVec2` | Live world XZ | Throttled `POS_SYNC_HZ` |
| `playerColorSlot_1..5` | `manualVec2` | Unchanged from 2.0 | Unchanged |

Notes:
- StorageProperty has **no typed-array types** — `manualIntArray` takes a plain `number[]`. Keep the working mask as a `Uint32Array` locally; copy to a reused `number[]` only at write time.
- Set `sendsPerSecondLimit` **explicitly on every property** (default is -1 = unlimited). Mask/seq: no limit needed (event-driven writes); trail: `TRAIL_SYNC_HZ`; pos: `POS_SYNC_HZ`.
- All same-frame property writes batch into **one** network message (official behavior) — write mask + seq together.
- **Read rule carries over from 2.0**: always read `currentValue`, never `currentOrPendingValue`, for any property that may have been subscribed after the store already held a value (`silentSetCurrentValue` seeds only `currentValue`). This applies to all the new keys on late join.
- Single-writer-per-key means the *author* of any key's value is, by construction, the player named in the key — the ghost predicate check simplifies accordingly (§1.5).

### 1.2 Property lifecycle

At entity-ready, each client registers its **own** four keys and subscribes to every other present player's keys (enumerate via `currentStore.getAllKeys()` prefix scan + presence events for players joining later). Keys are never per-cell and never lazily accreted — TD-10 (unbounded subscription growth) is retired.

### 1.3 Local derived state (per client, not synced)

- `ownMask: Uint32Array` — working copy of local player's territory.
- `remoteMasks: Map<clientID, Uint32Array>` — decoded from `mask_*` on change events.
- `trailRaster: Int32Array(GRID_N²)` — cell → trail-owner clientID (0 = none). Rebuilt incrementally: on any `trail_*` change, re-rasterize that player's polyline (Bresenham-densified between points, and extended to their `pos_*` head for freshness). Own trail rasterizes locally at 10 Hz (no latency).
- `ownTrailTicks: Int32Array` or ring buffer — per own-trail-cell timestamp for the grace window (R11).

### 1.4 The new `sendData` (per 10 Hz tick, alive branch)

The 2.0 five-branch cell decision tree collapses to:

1. Bresenham from previous to current cell; for each crossed cell:
   a. Out of bounds → `killLocalPlayer()` (unchanged).
   b. `firstClaim` armed → try home-claim disc (all disc cells in-bounds + free across all masks and `trailRaster`); on success write mask+seq, disarm; else stay deferred (R16).
   c. `trailRaster[cell]` names a **present** enemy → fire death RPC (kill them, R9). Not present → ghost trail: clear locally and let the owner's absence-cleanup zero the key (R10).
   d. `trailRaster[cell] === ownID` and cell older than grace window → self-death (R11).
   e. Cell in `ownMask` and trail non-empty → **capture** (§1.6).
   f. Cell not in `ownMask` → append to trail (raw position + raster + tick), R2.
2. Throttled writes of `trail_`/`pos_` happen via the property send limits, not manual timers.

### 1.5 Death, leave, ghosts — mechanism mapping

All 2.0 machinery survives; only the "what to clear" changes:

| 2.0 mechanism | 3.0 form |
|---|---|
| Phase 1 local teardown | Same + clear `ownMask`, trail buffers, rasters; epochs still bump |
| Phase 2 remote visual sweep (Instantiator iteration, owner stamps) | **Deleted** — visuals are local; teardown = destroy that player's locally-built objects + rebuild |
| Phase 3 cell sweep (~1600 keys, pending-value matching) | Victim zeroes own 4 keys. For non-self deaths, remaining clients *also* zero the dead player's keys (idempotent, NET-6-class accepted) |
| Full-store leave sweep + chunked heals + re-sweeps | Zero the leaver's 4 keys; re-sweeps shrink to re-zeroing 4 keys |
| Ghost cell interceptor (`onAnyChange` per cell) | Per-player-key interceptor: incoming nonzero `mask_/trail_/pos_/maskSeq_` for a ghost owner (`isGhostID`, unchanged predicate) → zero it |
| `getCellProperty` seed-check | Seed-check at subscription of each per-player key (same reason: seeded values fire no events) |
| Color slot free / reclaim, presence cache, recently-dead TTL, join-window replay | Unchanged verbatim |

The TTL invariant survives unchanged: respawn home claims are written ≥3 s after death, outside the 2 s ghost window; the `onAwake()` clamp stays.

### 1.6 Events

- **`playerDeathEvent`**: payload upgraded `vec3 → vec4(deadID, killerID, victimVisualID, cause)`. Cause codes: `1` trail kill, `2` self-collision, `3` out-of-bounds, `4` reserved (leave is synthesized locally by `onUserLeftSession`, no RPC — 2.0 parity). vec4 round-trips the RPC JSON codec natively. All 2.0 listener guards (ID-0 drop, pre-ready queue + bounded replay) carry over.
- **`captureEvent`** (new): `{ capturerID, seq, bboxX, bboxZ, bboxW, bboxH, bits: number[] }` — the captured region as a bbox-local bitmask (plain object; JSON-serializable payloads are supported). Consumers: victims carve the region from their own mask and rewrite it; all clients may use it to trigger the capture animation.
- **Convergence without the event**: masks can transiently overlap (capture written, carve not yet applied — ~1 RTT; longer if a victim missed the event). Two rules make this safe:
  1. **Render/logic precedence**: a cell set in multiple masks belongs to the higher `maskSeq` (tie → higher clientID). Deterministic on every client.
  2. **Self-reconciliation**: whenever a client sees a remote mask update overlapping its *own* mask with a higher seq, it carves itself. Guarantees convergence even if the capture event was lost, with no third-party writers.

### 1.7 Rate & size budget

Worst case 5 players: masks 5 × 3.2 KB = 16 KB store (vs ~1 MB); message rate ≈ 5 × (`TRAIL_SYNC_HZ` + `POS_SYNC_HZ`) + capture/death events ≈ **25–30 msg/s** vs the 50/s design budget (250 per 5 s, shared with SyncKit's own traffic). Phase 1 measures `getMaxSizeInBytes()` and the actual rate-limit onset.

---

## 2. Territory rendering pipeline

### 2.1 Vendored libraries → `Assets/GrantWork/Scripts/Vendor/`

| File | Source | License | Size | Notes |
|---|---|---|---|---|
| `Contours.ts` | d3-contour `src/contours.js` (github.com/d3/d3-contour) | ISC | ~270 lines | Strip the `d3-array` imports by hard-coding threshold `0.5`; emits GeoJSON-style MultiPolygon (exterior CCW rings + CW holes, stitched) |
| `Simplify.ts` | simplify-js (github.com/mourner/simplify-js) | BSD-2 | ~120 lines | Radial + RDP; for closed rings rotate so a true corner is the seam before simplifying |
| `Earcut.ts` | earcut (github.com/mapbox/earcut) | ISC | ~700 lines | `earcut.flatten()` for ring lists; triangulates polygons with holes in <1 ms at our sizes |
| `Chaikin.ts` | hand-written | — | ~20 lines | Closed-ring corner cutting, `CHAIKIN_ITERS` iterations; deviation bound ≤ ~0.18 cells |
| `CatmullRom.ts` | hand-written | — | ~40 lines | **Centripetal** (α = 0.5) — the variant that is cusp/self-intersection-free; for trails |

Do **not** vendor the npm `marchingsquares` package (AGPL). No package.json changes — these are plain source files compiled by Lens Studio's TS (ES2019/CommonJS, non-negotiable target).

### 2.2 Rebuild flow (per player, event-driven)

```
mask changed (local write or remote onAnyChange)
  → set dirty[player]; coalesce to ≤1 rebuild per player per frame
  → contours(mask)                    // MultiPolygon, holes handled by winding
  → per ring: simplify(SIMPLIFY_TOL_CELLS) → chaikin(CHAIKIN_ITERS)
  → cells → world cm (× CELL_SIZE_M × 100, arena-origin offset)
  → ground fill: earcut per polygon → MeshBuilder (Triangles, UInt16)
  → wall band:   per ring, quad strip extruded 0 → WALL_HEIGHT_M
  → RenderMeshVisual.mesh = builder.getMesh(); builder.updateMesh()
```

- **MeshBuilder reference implementation lives in the repo**: `Packages/SpectaclesInteractionKit.lspkg → Package/Assets/Utils/views/LineRenderer/LineRenderer.ts` (`new MeshBuilder([...])`, `topology`, `appendVerticesInterleaved`, `updateMesh`) and `LineMeshUtils.ts` (miter math). Copy the pattern, not the files.
- Vertex format: position only (+ per-mesh material color); no normals needed for unlit materials.
- **UInt16 cap**: 65,536 vertices per mesh — territory at our scale is a few thousand; still, keep fill and wall as separate meshes per player, and split at ~20 m tiles if a territory grows huge (also restores frustum culling on the 80 m arena).
- **Z-fighting**: per-player ground-fill y-offset (`+0.5 cm × playerIndex`). Check the main camera far plane covers the arena diagonal (~11,400 cm).
- **GC discipline**: reuse grow-only scratch buffers (`Float32Array` vertices, `number[]` for API boundaries); no `vec2`/`vec3` allocation inside the pipeline loops; no string keys.
- Epoch guards: rebuilds capture `deathEpoch` (2.0 pattern) and abort if the player died mid-rebuild slice.

### 2.3 Trail ribbon

```
points = own: raw 10 Hz samples | remote: trail_<id> ∪ pos_<id> head, lerped between updates
  → centripetal Catmull-Rom, 4–8 subdivisions/segment
  → thick polyline: miter-joined ribbon (LineMeshUtils math), miter limit 2–3× width → bevel fallback
  → vertical extrusion to stake-cube height → MeshBuilder
pillars: every PILLAR_SPACING_M of arc length → ObjectPrefab.instantiate(parent) — LOCAL, not Instantiator
```

Track pillars per player in a plain array; destroy + rebuild with the ribbon. `safeDestroy` (2.0's hardened destroy) is reused.

---

## 3. Minimap (render-target rig)

1. New `RenderTarget` asset, fixed `MINIMAP_RT_PX²` (256), clear color transparent-black.
2. New orthographic `Camera`: top-down (−Y), `size = MINIMAP_WINDOW_M`, dedicated render-layer bit, `renderTarget` = the new asset, follows the local player's continuous XZ each frame, fixed yaw (north-up). The existing scene's ortho UI camera (in `Scene.scene`) is the settings template; SpectaclesUIKit's `DebugCamera.ts` proves runtime camera+RT creation if we prefer script-side setup.
3. Layer assignment: ground-fill meshes and trail ribbons get the minimap layer bit **added** to their `renderLayer` mask (walls and pillars do not — top-down they'd just occlude). Extras drawn only on the minimap layer: arena border frame, remote-player dot quads at `pos_<id>` tinted by visual ID, gray out-of-bounds backdrop.
4. The Full Frame Region `Image` displays the RT texture. The player arrow keeps `rotatePlayerArrow` only, pinned at center.
5. **Deleted**: the 25 `Cell00–Cell44` Images and their alignment (`alignMiniMapCells`), stake dots (`positionStakeDot`/`applyStakeDot`), the arrow slide (`getMiniMapArrowOffset`, `positionPlayerArrow`, `captureArrowGeometry`), `getMiniMapCells`/`shouldRedrawMiniMap`/window-dirty machinery (~450+ lines across both files).
6. Fallback (if Phase 1 profiles the RT pass hot): `ProceduralTextureProvider.createWithFormat` + `setPixels(128², RGBA8Unorm, Uint8Array)` rasterizing the masks in TS; UV-pan for sub-cell scroll. Proven on Spectacles in official samples.

---

## 4. Score & kill feed

- **Score**: on any mask change, popcount that mask (loop over the Uint32Array with a bit-count; ~800 ints — trivial). Maintain `scores: Map<clientID, number>`; re-render the ranked list (≤5 rows, claim-color tinted, local row highlighted) only when values change. Denominator: `GRID_N²`.
- **Kill feed**: `names: Map<clientID, string>` fed by `seedPresentClients` + join/leave handlers (they already receive `displayName`; store it before hashing). Feed entries from: death RPC (cause codes 1–3) and `onUserLeftSession` (leave). Rolling 3-entry screen `Text` block, 4 s per-entry TTL via `DelayedCallbackEvent`. Unknown name fallback: `Player {visualID}`.

---

## 5. Per-file migration plan

Line numbers as of 2026-08-12 (commit `d969cdb3` + uncommitted doc edits); symbols are the stable reference.

### `Networker.ts` (1,642 lines → est. ~900)
- **Keep verbatim** (~700 lines): SyncEntity setup + ready flow; death RPC listener (payload widens to vec4); `onUserLeftSession`/`onUserJoinedSession`; presence cache (`presentClientIDs`, `seedPresentClients`, `isClientPresent`); ghost machinery (`recentlyDead`, `departedClients`, `isGhostID`, `registerRecentlyDead`, TTL clamp); color slots (all of it); `handlePlayerDeath` 4-phase skeleton; `replayPendingDeathCleanups`; `scheduleLeaveResweeps` (body shrinks); epochs (`conversionEpoch`, `deathEpoch`, validity closures); `respawn`; `killLocalPlayer`; `computeClientID`; `log`.
- **Replace**: `gridCells`/`localCellState`/`getCellProperty`/`getCellKey`/`updateCellValue`/`getData`/`getCellDataReadOnly` → §1 schema (`V3GridStore` region or class); `sendData` tree → §1.4; `addStakedRegionToClaim` + both sequential chains + `bresenhamLine`-for-barrier → capture routine (flood fill ported to `Uint32Array` masks — the algorithm itself is 2.0's, keep its logic); `deathPhaseCellSweep` + `sweepStoreForDepartedClient` + `healStoreCellsChunked` → zero-4-keys; minimap window functions → deleted (RT minimap needs no data API); `isInBounds`/`isLegalSpawnCell` → world/disc versions (same contracts).
- **Add**: mask codec (bit ops), trail raster maintenance, capture event send/receive + self-reconciliation, home-claim disc, grace-window bookkeeping, score popcount + change callbacks, names map.

### `PlayerVisuals.ts` (927 lines → slimmer, plus new files)
- **Keep**: HUD text, respawn countdown show/hide, `rotatePlayerArrow` + `previousRotation`, color tables (`getPlayerClaimColor`/`getPlayerStakeColor`), `safeDestroy`, `log`.
- **Delete**: 15 prefab inputs + `get*VolumeFromPlayerID` + `createWorldClaimVolume`/`createWorldStakeVolume`; Instantiator internals adapter trio + `pruneOnDestroy` + `destroyPlayerVisuals` + owner stamping (`OWNER_KEY`, `makeOwnerStore`) — nothing is network-spawned anymore; all 25-cell minimap code; arrow slide code; legacy dead methods (`updateMiniMap`, `createUICell`, `getCellColor`) and the `GridClaimer` import.
- **New sibling files**: `TerritoryMesh.ts` (per-player fill+wall builder), `TrailMesh.ts` (ribbon + pillars), `MiniMapRig.ts` (camera/RT/layers/dots), `KillFeed.ts`, `ScoreBoard.ts`, `Vendor/` (§2.1), `V3Config.ts` (tunables).

### `LocationTracker.ts` (250 lines → ~similar)
- **Keep**: onAwake ready-wiring, FNV-1a (`getDeterministicPlayerId` — stays byte-identical to `Networker.computeClientID`), 10 Hz loop skeleton, clientID-null guard, respawn countdown driver (predicate swap only), HUD call, rotation helper.
- **Replace**: `worldCoordsToGridPos`/cell constants → `V3Config` conversion; `isInSameCell` gating → cell-crossing via the new conversion; `getMiniMapArrowOffset` → deleted.

### Deletions (Phase 0, before anything else) ✅ done 2026-08-12
- `GridClaimer.ts` (358 lines), `UnionFindLoopDetection.ts` (121 lines) — zero scene references (verified 2026-08-12); plus `PlayerVisuals` dead methods above (~90 lines) and its `GridClaimer` import.

### Scene / asset changes (Lens Studio IDE work)
- Add: minimap `RenderTarget` asset + ortho camera object; `KillFeed` + `ScoreBoard` screen Text objects; flat claim-shader variants (5 materials or one parameterized); claim materials `CullMode → None`.
- Remove (Phase 3+): 25 minimap cell Images; (Phase 2 end) cube/pillar prefab wiring from `PlayerVisuals` inputs (prefab assets stay for pillars — still used, now locally instantiated; the 10 cube prefabs become unused and can be deleted at the end).
- Check: main camera far plane ≥ arena diagonal (~11,400 cm).

---

## 6. Phases

**Ordering rationale — rendering first**: the mesh pipeline (Phase 2) can be built against the *current* 2.0 store by deriving each player's `Uint32Array` mask locally from `gridCells` at 2 m cells. This validates the whole visual direction with zero networking risk, and the schema swap (Phase 4) then changes only where masks come from. The two workstreams are independent per the seam map.

### Phase 0 — Dead-code purge *(hours; zero behavior change)* ✅ **DONE 2026-08-12**
Delete `GridClaimer.ts`, `UnionFindLoopDetection.ts`, `PlayerVisuals.updateMiniMap`/`createUICell`/`getCellColor` + the `GridClaimer` import. **Exit**: compiles, plays identically. *(Also removed: `renderMiniMapCell`/`getCellMatClone` — same dead cluster — and both `.ts.meta` files. KNOWN_ISSUES DEAD-1/DEAD-2 closed; CLAUDE.md updated.)*

### Phase 1 — Experiment day, editor-based *(~½ day; produces go/no-go numbers)*
Run §7.1 in the Lens Studio editor (editor↔device perf measured ~1:1 for this project — see tracker decision 2026-08-12; hardware currently unavailable). **Exit**: measurements 1–5 recorded in this file; `CELL_SIZE_M` and minimap approach decided (OQ-3). Exp #6 (colocation drift) requires two physical devices — record it as deferred and run it when hardware returns.

### Phase 2 — Rendering overhaul on the 2.0 store *(largest phase)*
Vendor §2.1; build `TerritoryMesh`/`TrailMesh` fed by a local mask adapter over `gridCells` (2 m), behind a feature flag; own trail ribbon from raw 10 Hz samples (a parallel array next to `stakeList`); flat claim shader variants; delete cube spawning when meshes look right. **Exit**: smooth territory + ribbon trails + pillars on device in multiplayer; per-cell volume spawning gone; owner-stamp sweep code still present but idle (removed in Phase 4).

### Phase 3 — Render-target minimap *(~1 day)*
§3 rig; delete the 25-Image machinery. **Exit**: 28 m scrolling minimap on device; old minimap code gone.

### Phase 4 — Sync schema swap + kill feed + score *(days; the networking rewrite)*
§1 schema; new `sendData`; capture event + reconciliation; death/leave mapping (§1.5); vec4 death RPC + `KillFeed`; `ScoreBoard`; remove the per-cell store, write chains, store sweeps, Instantiator adapter/owner-stamp code. **Exit**: kill/capture/death/leave/rejoin parity demonstrated at 2 m cells across 3 devices; TD-10 retired; no rate-limit logger errors in a 15-minute session.

### Phase 5 — Resolution bump + feel pass *(days + playtest)*
Flip `CELL_SIZE_M` per Phase 1; grace window (R11); home-claim disc (R16) if not landed in Phase 4; remote position lerp; capture animation (OQ-2); tune trail width/wall height/minimap window. **Exit**: `V3_SPEC.md` §8 acceptance criteria pass.

---

## 7. Phase 1 experiment protocol

Editor-preview timings are trusted for this project: hands-on comparison found editor and Spectacles hardware performing ~1:1 (tracker decision, 2026-08-12), so all timing experiments below run in the editor. When hardware is next available, a quick device spot-check of the headline numbers is still worthwhile before locking Phase 5 decisions — but it gates nothing before then.

| # | Experiment | Method | Decision it feeds |
|---|---|---|---|
| 1 | `updateMesh()` cost curve | Rebuild 1k / 5k / 20k-triangle meshes at 1/5/10 Hz; watch CPU%, render ms, FPS in the Performance Overlay | Rebuild debounce/slicing strategy |
| 2 | 80 m mesh sanity | One textured arena-spanning mesh + 16-chunk variant; walk the edge; far-plane, z-fighting, GPU% | Chunk size; far-plane setting |
| 3 | Minimap A/B | 256 px ortho-RT rig vs `setPixels` 128² at ~2 redraws/s; CPU/GPU/render ms | Minimap option 4A vs 4B |
| 4 | Store & rate limits | `getMaxSizeInBytes()`; write a 3.2 KB int-array mask at 1/5/20 Hz per fake player; watch Logger for rate errors; measure propagation latency between two devices | Schema confidence; `TRAIL_SYNC_HZ` |
| 5 | JS speed | Flood-fill + marching-squares benchmark (160² Uint32Array) in editor preview; editor↔device ratio taken as ~1 (2026-08-12 decision) — re-run on device at next opportunity to confirm | **`CELL_SIZE_M` = 0.5 vs 1.0 (OQ-3)**; slicing need |
| 6 | Colocation drift | Two devices; shared anchor divergence at 10/40/80 m from mapping origin — **deferred until hardware available** (cannot run in editor) | Arena-size revisit trigger (spec keeps 80 m) |

### 7.1 Results *(fill in during Phase 1)*

```
1. updateMesh:        (pending)
2. 80 m mesh:         (pending)
3. minimap A/B:       (pending)
4. store/rate:        (pending)
5. JS speed (editor): (pending — ratio assumed ~1 per 2026-08-12 decision)
6. drift @10/40/80m:  (deferred — needs two physical devices; run when hardware returns)
```

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Device JS engine slow (no JIT) | Low — editor↔device observed ~1:1 (2026-08-12) | Exp #5 in editor; typed arrays everywhere; slice rebuilds across frames if numbers say so; 1 m fallback resolution; device spot-check when hardware returns |
| `updateMesh()` cost undocumented | Medium | Exp #1; debounce ≤1 rebuild/player/frame; chunk meshes |
| Colocation drift across 80 m | Medium (pre-existing in 2.0) | Exp #6; revisit arena size only on bad numbers |
| Translucent wall overdraw | Low–medium | Already shipping translucent cubes; cap wall alpha/height; Exp #2 |
| RT minimap pass cost | Low | Exp #3; §3.6 setPixels fallback is proven on device |
| Store byte cap unpublished | Low | Exp #4; payloads are 30× under the message cap regardless |
| Capture/carve overlap window | Low | Deterministic seq precedence + self-reconciliation (§1.6) — converges without third-party writers |
| Trail-kill latency vs 2.0 | Low | Remote trail raster lags ≤ `1/TRAIL_SYNC_HZ` + RTT — same class as 2.0's cloud-write latency; pos-head extension narrows it |
| PBR claim shaders on big meshes | Low | Flat/unlit variants (spec §5.3) |

---

## 9. Frozen research facts (do not re-derive)

**Platform (official Snap docs):**
- Sync limits: 100 KB/message; 350 msgs/5 s (Spectacles Sync Kit page) but an older Connected Lenses page says 250/5 s — design to 250. Storage API ~1 MB (support FAQ, semi-verified). Property writes batch per frame into one message. `GeneralDataStore` exposes `getMaxSizeInBytes()` + `onStoreFull`. Docs: developers.snap.com → spectacles-sync-kit → payload-and-rate-limits / storage-properties / networked-events.
- `MeshIndexType`: `None` | `UInt16` only → 65,536 vertices/mesh.
- Perf: ~16 ms frame @60 FPS target; ≤512 px textures; avoid PBR; ~100 k triangle ceiling; 150 MB RAM; profile via Performance Overlay / Spectacles Monitor. Multi-camera + render-target chaining is a documented workflow; only guidance is "fewer RTs = better".
- `ProceduralTextureProvider.createWithFormat` + `setPixels(x,y,w,h,Uint8Array)` — used in official Spectacles samples (Crop, BLE Playground).
- Scripting: ES2019 + CommonJS (locked); typed arrays supported; no `setTimeout` (use `DelayedCallbackEvent`); engine identity unpublished, but editor↔device performance was observed ~1:1 hands-on (2026-08-12) — editor timings are treated as representative.

**SpectaclesSyncKit internals (from package source, `Packages/SpectaclesSyncKit.lspkg` — a ZIP; read via `unzip -p`):**
- `StorageProperty` factories include `manualIntArray` (:734), `manualVec2Array` (:800), `manualString` (:452), etc. — full scalar+array matrix in `StorageTypes.ts:35-61`. **No typed-array storage types** (plain JS arrays only).
- `sendsPerSecondLimit` defaults to `-1` (unlimited) — `StorageProperty.ts:95-101`; a per-frame-mutated array resends the *whole array* every frame unless limited.
- No client-side size caps anywhere in kit source; oversized writes surface as caught+logged put failures (`putStoreValueDynamic`, `StorageProperty.ts:366-390`).
- RPC codec (`NetworkUtils.ts:147-241`): vec2/vec3/vec4/quat round-trip typed; plain objects/arrays round-trip as JSON; no chunking/size check — sender owns size risk.
- Instantiator is prefab-only (`instantiate(prefab: ObjectPrefab, …)`, `Instantiator.ts:452`; remote clients resolve by `_prefab_name` and **throw** on unknown). Runtime meshes cannot travel through it — hence local-view architecture.
- `silentSetCurrentValue` seeds `currentValue` (+`pendingValue`) but **not** `currentOrPendingValue`, and fires no events → the 2.0 `currentValue` read rule + seed-check pattern applies to all new keys.
- Working MeshBuilder reference in-repo: SIK `LineRenderer.ts` / `LineMeshUtils.ts` (miter-join thick polylines, `updateMesh` per frame).

**Genre & algorithms (design study, 2026-08-12):**
- All open paper.io-likes are grid-core (splix.io — MIT source, 1 cell ≈ player width; superhex.io — 87k hex cells; every findable clone). The smooth-look stack used in practice: marching squares → simplify → smooth → triangulate; the one documented bottleneck (libtess) is avoided by earcut (<1 ms at our sizes).
- Chaikin (2 iters) deviation bound ≈ 0.18 cells at right angles — rendered outline can't leak into neighbor cells. Catmull-Rom must be **centripetal** (α=0.5) to avoid cusps; use for trails only (interpolating), never for grid contours (reproduces staircase).
- CPU anchors (desktop-class JS): marching squares 160² ≈ 1–3 ms; flood fill ≈ 1.5–3 ms/capture; simplify+Chaikin+earcut ≪1 ms each. Multiply by Exp #5's device ratio.
- Pipeline cost is event-driven (per capture), not per-tick.

**Codebase (seam-map audit, 2026-08-12):**
- `GridClaimer.ts` + `UnionFindLoopDetection.ts`: zero scene references, dead.
- ~700 lines of `Networker.ts` (death/ghost/presence/color/epoch/respawn) are coordinate-agnostic and survive verbatim.
- Scene has exactly 2 cameras (main perspective + ortho UI, both → the device render target); no spare RT — minimap rig is net-new.
- 15 P1–P5 materials ready for runtime meshes; claim mats are PBR + `CullMode: Back` (both need addressing, spec §5.3).
