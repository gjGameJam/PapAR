# KNOWN_ISSUES.md — Defect & Tech-Debt Register

> Status-tracked companion to `CLAUDE.md`. `CLAUDE.md` documents **how the system works**
> (architecture, data flow, coordinate systems); this file tracks **what's wrong or
> incomplete** and where to fix it. When an item here is resolved, update its status and
> mirror the change into the relevant `CLAUDE.md` section.
>
> **Last updated:** 2026-07-09
> **Line numbers** are marked "as of 2026-07-09" and will drift — the file + symbol/function
> name is the durable anchor.

---

## How to use this file

- Every finding has a stable **ID**, a **severity**, a **status**, a **location**
  (file + symbol), the **impact**, a **repro/trigger**, and a **fix hint**.
- Severity reflects gameplay/data impact in realistic play, not just theoretical risk.
- IDs prefixed `D#` correspond to the original 3-round audit's "Defects" numbering so they
  tie back to that discussion; other prefixes (`NET`, `DEAD`, `TD`, `FEAT`) are grouped by
  category.

**Severity:** 🔴 High · 🟠 Medium · 🟡 Low
**Status:** ✅ Fixed · 📝 Documented (not fixed) · ⬜ Open

---

## Status summary

| ID | Title | Sev | Status |
|----|-------|-----|--------|
| D1 | Arrow-rotation guard never memoized | 🟡 | ✅ Fixed |
| D2 | Arrow-rotation doc mismatch + dead locals | 🟡 | ✅ Fixed |
| D4 | Home claim skipped when spawn cell is (0,0) | 🟠 | ✅ Fixed |
| LOG | Per-tick `print` spam not gated by `showLogs` | 🟠 | ✅ Fixed |
| D3 | Delayed 500 ms stake write clobbers claim / writes for dead player | 🟠 | 📝 Documented |
| NET-1 | ClientID race — `sendData` can run with `clientID = undefined` | 🟠 | ⬜ Open |
| NET-2 | clientID `0` (null display name) collides with "unclaimed" | 🟡 | ⬜ Open |
| NET-3 | Conversion/interior chains continue after death | 🟠 | ⬜ Open |
| NET-4 | Interior ray-cast fill wrong on diagonal loops | 🟠 | ⬜ Open |
| NET-5 | Death cloud cleanup is best-effort (stale ghost cells) | 🟡 | ⬜ Open |
| NET-6 | Redundant simultaneous death-cleanup writes | 🟡 | ⬜ Open |
| NET-7 | 6th+ player overwrites an active color slot | 🟠 | ⬜ Open |
| NET-8 | Respawn cell can be stolen in the last 0.3 s window | 🟡 | ⬜ Open |
| DEAD-1 | `GridClaimer` single-player pipeline dead; `updateMiniMap` colors latently broken | 🟡 | ⬜ Open |
| DEAD-2 | `UnionFindLoopDetection` empty stub component | 🟡 | ⬜ Open |
| DEAD-3 | Dead legacy GPS fields in `LocationTracker` | 🟡 | ⬜ Open |
| DEAD-4 | Dead helpers `coordsToIndex` / `indexToCoords` / `lastIdx` | 🟡 | ⬜ Open |
| TD-1 | `getData()` now called every tick for nothing (post-LOG) | 🟡 | ⬜ Open |
| TD-2 | FNV hash + coord conversion + constants duplicated across files | 🟡 | ⬜ Open |
| TD-3 | `as any` reach into SyncKit `spawnedInstances` internals | 🟠 | ⬜ Open |
| TD-4 | `updateHUDText` misleading legacy param names | 🟡 | ⬜ Open |
| TD-5 | `Array(25).fill(vec2.zero())` shares one instance | 🟡 | ⬜ Open |
| TD-6 | `getCellDataReadOnly` has no cache TTL (unlike `getData`/`getMiniMapCells`) | 🟡 | ⬜ Open |
| TD-7 | Magic numbers (delays, TTL, `scale/6`) uncentralized | 🟡 | ⬜ Open |
| TD-8 | Non-strict TS: `map.has()`→`map.get()` deref without narrowing | 🟡 | ⬜ Open |
| TD-9 | Stale `spawnedInstances` refs linger after self-death | 🟡 | ⬜ Open |
| FEAT-1 | No kill on entering enemy **claimed** territory | — | ⬜ Missing |
| FEAT-2 | No score / leaderboard | — | ⬜ Missing |
| FEAT-3 | No kill feed / death announcement | — | ⬜ Missing |
| FEAT-4 | Minimap snaps per-cell (no sub-cell indicator) | — | ⬜ Missing |

---

## Resolved this session (2026-07-09)

### ✅ D1 — Arrow-rotation guard never memoized
`PlayerVisuals.onUpdate()` compared `previousRotation != yawRadians` but never wrote
`previousRotation`, so the "rotate only when heading changed" guard was inert (arrow
rebuilt its quaternion nearly every frame; and if yaw were ever exactly `0` it wouldn't
update). **Fix:** added `this.previousRotation = yawRadians;` inside the guard.

### ✅ D2 — Arrow-rotation doc mismatch + dead locals
The arrow math was correct on-device, but `CLAUDE.md` described a different formula
(`-yawRads + π/2` on a `ScreenTransform`) than the code runs
(`quat.fromEulerAngles(0, 0, yawRads)` on a 3D `Transform`). **Fix:** corrected both
`CLAUDE.md` passages (§"Rotation" and §"Direction arrow") and tidied `rotatePlayerArrow`
(removed dead `yawDegrees`, inlined redundant `adjustedRads`). No behavior change.

### ✅ D4 — Home claim skipped when spawn cell is (0,0)
`PlayerVisuals.prevGridPos` initialized to `(0,0)`; a player whose first grid cell was
literally `(0,0)` got `isInSameCell → true` on the first ready tick, so the `firstClaim`
home claim never fired until they moved. **Fix:** initializer is now the out-of-range
sentinel `(-1,-1)` (no in-bounds cell is negative). Respawn path is unaffected — it
re-syncs `prevGridPos` explicitly.

### ✅ LOG — Per-tick logging not gated
`showLogs` defaulted `true` and many hot-path `print`s ignored it entirely (`getData`
every tick; `getCellProperty` ×25/tick from the minimap; `onAnyChange`; `updateCellValue`)
— ~100+ prints/sec on-device. **Fix:** each active class got a `showLogs`-gated
`private log(msg)` helper; all ~90 `print(` call sites route through it; `showLogs` is now
an `@input boolean = false` per file (Networker, PlayerVisuals, LocationTracker) — off by
default, toggle in the Inspector. `GridClaimer` (dead code) left untouched. **New logging
must use `this.log(...)`, not `print(...)`.**

---

## Open defects

### 📝 D3 — Delayed 500 ms stake write clobbers a completed claim / writes for a dead player
- **Sev:** 🟠 Medium · **Location:** `Networker.sendData()`, enemy-stake branch,
  `delayedWrite.reset(0.5)` (~L413, as of 2026-07-09).
- **What/why:** When you step onto a cell staked by *another* player, the cell is pushed to
  `stakeList`, cached in `localCellState`, and given a stake visual **immediately**, but the
  cloud write is deferred 500 ms. The delay is intentional — it makes our stake land in the
  cloud *after* the killed player's `handlePlayerDeath` death-clear, so our stake wins the
  race instead of being erased. The closure captures the cell coords/value with **no
  cancellation**.
- **Impact / repro:** (1) If you loop back to your own claim within 500 ms,
  `addStakedRegionToClaim` converts that cell to a claim (`vec2(clientID, 0)`) and spawns a
  claim visual, then the late callback overwrites the cloud cell back to a stake — the cell
  reads staked while its visual shows claimed. (2) If you die within 500 ms, the callback
  still fires and writes a stake for a now-dead player.
- **Fix hint:** Tag the pending write (e.g., a token/sequence per cell) and cancel/no-op it
  in `addStakedRegionToClaim` (on conversion) and in `handlePlayerDeath` (on death). Related:
  NET-3. See `CLAUDE.md` §"Known Incomplete Areas → Networking".

### NET-1 — ClientID race: `sendData` can run with `clientID = undefined`
- **Sev:** 🟠 Medium · **Location:** `LocationTracker.onAwake()` — two independent
  `notifyOnReady` callbacks (`SessionController` sets `clientID`; `Instantiator` starts the
  position loop).
- **Impact:** If the instantiator becomes ready first, the position loop starts before
  `clientID`/`playerID` are assigned. A cell-change in that window calls
  `sendData(undefined, …)`, writing `vec2(NaN, 0)` to the cloud and selecting a null prefab
  (`getClaimVolumeFromPlayerID(undefined) → null`) for the home claim.
- **Fix hint:** Gate the position loop on both readiness signals (only start once
  `clientID` is set), or early-return in `sendData`/`handleRespawnCountdown` while
  `clientID == null`.

### NET-2 — clientID `0` collides with the "unclaimed" sentinel
- **Sev:** 🟡 Low · **Location:** `LocationTracker.getDeterministicPlayerId()` returns `0`
  for a null display name; cell `.x/.y === 0` means unclaimed/unstaked.
- **Impact:** A player who joins with a null display name has `clientID = 0`, so their own
  claims read as "unclaimed" in `sendData`'s decision tree — they perpetually re-stake their
  own territory and never trigger loop closure. `Networker.computeClientID` already guards
  the *leave* path (skips cleanup when hash is 0), but the join path is unguarded.
- **Fix hint:** Map a 0 hash to a non-zero fallback, or reject/replace null display names.

### NET-3 — Conversion / interior-fill chains continue after death
- **Sev:** 🟠 Medium · **Location:** `Networker.convertStakesSequentially()` (40 ms chain,
  `reset(0.04)` ~L688) and `claimInteriorCellsSequentially()` (50 ms chain, `reset(0.05)`
  ~L786). Neither checks `isAlive`.
- **Impact:** If a death RPC arrives mid-conversion, `handlePlayerDeath` tears down state and
  visuals, but the in-flight `DelayedCallbackEvent` chain keeps spawning claim visuals and
  writing cells for the dead player until it drains. A chain still running when the player
  respawns can interleave its writes with the new life's home claim. (`respawn()` clears
  `isPerformingBulkConversion`, so it can't *wedge*, but it can still interleave.)
- **Fix hint:** Have both chains early-return when `!isAlive`, and/or version each
  conversion batch so a stale chain aborts.

### NET-4 — Interior ray-cast fill is wrong on diagonal loops
- **Sev:** 🟠 Medium · **Location:** `Networker.isInLoop()` / `findAndFillEnclosedRegion()`.
- **Impact:** The ray-cast treats discrete cells as point coordinates and closes the loop
  with a straight `last→first` edge. Convex/simple concave loops fill correctly, but diagonal
  or self-adjacent trails produce ambiguous crossings and mis-filled interiors.
- **Fix hint:** Fill on the cell grid (flood-fill bounded by stake+claim cells) rather than
  point-in-polygon, or densify the loop edges to unit steps before ray-casting.

### NET-5 — Death cloud cleanup is best-effort (stale ghost cells)
- **Sev:** 🟡 Low · **Location:** `Networker.handlePlayerDeath()` Phase 3 — iterates only
  `gridCells` (cells this device has `getCellProperty`'d).
- **Impact:** Cells the dead player claimed that no *remaining* client has subscribed to stay
  non-zero in the cloud indefinitely. No visual impact until someone walks within ±2 cells,
  at which point the minimap subscribes and shows the stale claim (colored via the
  `(clientID % 5) || 5` fallback since the color slot was freed).
- **Fix hint:** A periodic/def­erred purge, or authoritative server-side ownership, would be
  needed. No active purge exists.

### NET-6 — Redundant simultaneous death-cleanup writes
- **Sev:** 🟡 Low · **Location:** `Networker.handlePlayerDeath()` runs on every remaining
  client (via RPC and `onUserLeftSession`).
- **Impact:** Each remaining client independently writes `vec2.zero()` to the same cells —
  idempotent but O(remaining players × dead player's subscribed cells) redundant traffic.
- **Fix hint:** Elect a single cleaner (e.g., lowest clientID present) or rely on the killer
  only.

### NET-7 — 6th+ player overwrites an active color slot
- **Sev:** 🟠 Medium · **Location:** `Networker.assignAndWritePlayerID()` — only 5 color
  slots; the fallback is `(clientID % 5) || 5`, which **overwrites** an occupied slot.
- **Impact:** A 6th concurrent player claims another active player's color slot; both then
  read/write the same `vec2(clientID, playerID)` slot, corrupting color assignment for both.
  No hard cap enforces ≤5.
- **Fix hint:** Enforce a 5-player cap (reject/limit join), or extend the slot scheme.

### NET-8 — Respawn cell can be stolen in the last 0.3 s window
- **Sev:** 🟡 Low · **Location:** `LocationTracker.handleRespawnCountdown()` — the read
  (`getCellDataReadOnly`) and the respawn `sendData` are one tick apart.
- **Impact:** If an enemy claims the respawn cell in the 0.3 s between the final "open
  ground" check and the respawn, the forced home claim silently overwrites their claim.
  Related: the respawning player's color can change if another player grabbed their freed
  slot during the dead window (see `respawn()` → `assignAndWritePlayerID`).
- **Fix hint:** Re-verify the cell is open at the instant of respawn before writing the home
  claim; if not, extend the countdown one more tick.

---

## Dead / broken code

### DEAD-1 — `GridClaimer` single-player pipeline is dead; `updateMiniMap` colors latently broken
- **Sev:** 🟡 Low · **Location:** `GridClaimer.ts` (whole component's runtime path);
  `PlayerVisuals.updateMiniMap()` / `renderMiniMapCell()` / `getCellColor()` /
  `createUICell()`.
- **Detail:** `GridClaimer.updatePos()` (the only caller of `updateMiniMap`) is commented out
  in `LocationTracker`, so this entire local-`SparseGrid` render path is unreachable.
  `Networker` + `updateMiniMapNetworked` superseded it. If ever re-enabled, `getCellColor`
  returns 0–255 `vec4`s (e.g. `new vec4(255,0,0,0.5)`) where shaders expect 0–1 — it would
  render fully clipped. `SparseGrid` and `CellState` are still legitimately imported/used and
  should stay.
- **Fix hint:** Delete the dead render methods and the `GridClaimer` component's game logic,
  keeping `SparseGrid`/`CellState` if still needed, or drop `GridClaimer` from the scene.

### DEAD-2 — `UnionFindLoopDetection` empty stub
- **Sev:** 🟡 Low · **Location:** `UnionFindLoopDetection.ts` — `LoopDetection` compiles to a
  no-op `BaseScriptComponent`; its whole body is commented out (abandoned in favor of the
  ray-cast fill).
- **Fix hint:** Delete the file (and detach from the scene if attached).

### DEAD-3 — Dead legacy GPS fields in `LocationTracker`
- **Sev:** 🟡 Low · **Location:** `LocationTracker.ts` — `latitude`, `longitude`, `altitude`,
  `horizontalAccuracy`, `verticalAccuracy`, `timestamp`, `locationSource` (~L9-15),
  `repeatUpdateUserLocation` (~L36), `locationService` (~L38), `hasStarted` (~L39). None are
  read/written; leftovers from a GPS-based prototype.
- **Fix hint:** Remove all ten fields.

### DEAD-4 — Dead helpers `coordsToIndex` / `indexToCoords` / `lastIdx`
- **Sev:** 🟡 Low · **Location:** `Networker.ts` — `lastIdx` (~L35), `coordsToIndex()`
  (~L513), `indexToCoords()` (~L518). Never called (the grid is a keyed `Map`, not a flat
  index).
- **Fix hint:** Remove.

---

## Tech debt / antipractices

### TD-1 — `getData()` is now called every tick for nothing
- **Sev:** 🟡 Low · **Location:** `LocationTracker` position loop calls
  `Networker.getData(clientID, x, y)` every 0.3 s (~L121). Its return value's only consumer
  was a debug `print`, now gated off by the LOG fix. Its `ID` parameter is unused inside the
  body. So the call is pure per-tick overhead post-LOG.
- **Fix hint:** Delete the per-tick `getData` call (and the unused `ID` param), or keep it
  only inside an `if (showLogs)` guard.

### TD-2 — Duplicated hash / coordinate conversion / constants
- **Sev:** 🟡 Low · **Location:** FNV-1a hash in both
  `LocationTracker.getDeterministicPlayerId` and `Networker.computeClientID`;
  `worldCoordsToGridPos` / `gridPosToWorldCoords` copied across `LocationTracker`,
  `Networker`, `GridClaimer`; constants `unitsPerCell = 200`, `gridRadius = 20`,
  `height = 40` re-declared in every file.
- **Risk:** Any change must be made in 2–3 places; silent divergence.
- **Fix hint:** Extract a shared `GridMath`/`PlayerId` util module.

### TD-3 — `as any` reach into SyncKit `spawnedInstances`
- **Sev:** 🟠 Medium · **Location:** `PlayerVisuals.destroyPlayerVisuals()` —
  `(this.networkedInstantiator as any).spawnedInstances` (~L238).
- **Risk:** Depends on a private SpectaclesSyncKit map; a SDK update can silently break
  remote-player visual cleanup (dead players' cubes would persist on other devices).
- **Fix hint:** Track spawned objects ourselves (keyed by clientID/prefab) instead of reading
  SDK internals, or use a supported public API if one exists.

### TD-4 — `updateHUDText` misleading legacy param names
- **Sev:** 🟡 Low · **Location:** `PlayerVisuals.updateHUDText(lat, long, gridx, gridy, …)`
  is actually passed grid + world coords, not GPS. Labels in the rendered string are correct;
  only the parameter names lie.
- **Fix hint:** Rename params (e.g. `gridX, gridY, worldX, worldZ`) and drop the unused
  `latOff/longOff`.

### TD-5 — `Array(25).fill(vec2.zero())` shares one instance
- **Sev:** 🟡 Low · **Location:** `Networker.getMiniMapCells()` not-ready return (~L280) — all
  25 slots reference the same `vec2`. Harmless today (read-only), a latent aliasing bug if a
  consumer ever mutates a cell.
- **Fix hint:** `Array.from({length:25}, () => vec2.zero())`.

### TD-6 — `getCellDataReadOnly` has no cache TTL
- **Sev:** 🟡 Low · **Location:** `Networker.getCellDataReadOnly()` returns any
  `localCellState` entry regardless of age, unlike `getData`/`getMiniMapCells` (5 s TTL).
  Currently safe because `localCellState` is cleared on death and not repopulated while dead
  (its only caller is the respawn read), but the inconsistent contract will mislead future
  callers.
- **Fix hint:** Apply the same 5 s TTL, or document the intentional difference at the call
  site.

### TD-7 — Magic numbers uncentralized
- **Sev:** 🟡 Low · **Location:** conversion delay `0.04`, interior delay `0.05`, delayed
  stake `0.5`, cache TTL `5000`, visual drop `scale/6`, respawn `3.0`/`0.30`. Scattered as
  literals.
- **Fix hint:** Promote to named constants (some already are in `CLAUDE.md`'s constants
  table — mirror them in code).

### TD-8 — Non-strict TS `map.has()`→`map.get()` deref
- **Sev:** 🟡 Low · **Location:** e.g. `Networker.sendData()` builds `currentCellValue` via
  `localCellState.has(k) ? localCellState.get(k) : …`, then dereferences `.x/.y`. `get()` is
  typed `vec2 | undefined`; only safe because strict null checks are off.
- **Fix hint:** Bind the `get()` result to a local and null-check it (works regardless of TS
  strictness).

### TD-9 — Stale `spawnedInstances` refs after self-death
- **Sev:** 🟡 Low · **Location:** On self-death, `DestroyAllClaims/Stakes` destroy the local
  objects and clear the tracking arrays, but the now-invalid `SceneObject` refs remain in the
  Instantiator's `spawnedInstances`. Harmless in practice (self path never calls
  `destroyPlayerVisuals`), but would bite if that ever changed.
- **Fix hint:** No action required unless the self-death teardown path changes; noted for
  awareness.

---

## Missing features (design gaps, not defects)

- **FEAT-1 — Kill on entering enemy claimed territory:** `sendData` only kills the owner of a
  **stake trail**; stepping into an enemy **claim** just stakes over it. To add: in the
  `else` branch, `if (claimedBy !== 0 && claimedBy !== ID)` fire a `playerDeathEvent` for the
  entering player.
- **FEAT-2 — Score / leaderboard:** no per-player cell count. Could derive by scanning
  subscribed `gridCells`, or track a dedicated `StorageProperty<number>` per player.
- **FEAT-3 — Kill feed / death announcement:** deaths only `this.log`. The
  `playerDeathEvent` payload already carries `vec2(deadPlayerID, killerID)`
  (`killerID === deadPlayerID` ⇒ voluntary leave).
- **FEAT-4 — Sub-cell minimap indicator:** the minimap snaps on cell-boundary crossings; a
  fractional-position marker would smooth it.

---

## Cross-reference to `CLAUDE.md` (functionality context)

| Topic | `CLAUDE.md` section |
|-------|---------------------|
| Position loop, respawn countdown, IDs | "Script Architecture → `LocationTracker.ts`" |
| Cell format, `sendData` decision tree, death handling, respawn | "`Networker.ts`" |
| Stake→claim conversion, interior fill | "Stake → claim conversion pipeline" / "Interior fill algorithm" |
| `currentValue` vs `currentOrPendingValue` gotcha | "Networking Architecture → Reading lazily-subscribed properties" |
| Visual spawning, minimap, arrow, HUD, respawn text | "`PlayerVisuals.ts`" |
| Player identity, color cycling | "Player Identity & Color Cycling" |
| Prior resolved networking bugs (1–7) | "Frontend Networking — Resolved Bugs" |
| Full open-issue prose | "Known Incomplete Areas" |
| Submission blockers (IP, safety, metadata) | "Lens Publication — Known Submission Blockers" |
