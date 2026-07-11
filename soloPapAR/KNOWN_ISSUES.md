# KNOWN_ISSUES.md — Defect & Tech-Debt Register

> Status-tracked companion to `CLAUDE.md`. `CLAUDE.md` documents **how the system works**
> (architecture, data flow, coordinate systems); this file tracks **what's still wrong or
> incomplete** and where to fix it.
>
> **Policy:** when an item is resolved, **remove it from this register** (git history keeps the
> detail) and mirror the change into the relevant `CLAUDE.md` section. This file lists only
> open/documented/missing work — no "resolved" archive, to keep it scannable.
>
> **Last updated:** 2026-07-11
> **Line numbers** are approximate and will drift — the file + symbol/function name is the
> durable anchor.

---

## How to use this file

- Every finding has a stable **ID**, a **severity**, a **status**, a **location**
  (file + symbol), the **impact**, a **repro/trigger**, and a **fix hint**.
- Severity reflects gameplay/data impact in realistic play, not just theoretical risk.
- ID prefixes group findings by category: `D#` (from the original audit's "Defects"
  numbering), `NET` (networking), `DEAD` (dead/broken code), `TD` (tech debt), `FEAT`
  (missing features). IDs are stable anchors — numbering gaps mean an item was fixed and
  removed.

**Severity:** 🔴 High · 🟠 Medium · 🟡 Low
**Status:** 📝 Documented (not fixed) · ⬜ Open · ⬜ Missing (design gap)

---

## Status summary

| ID | Title | Sev | Status |
|----|-------|-----|--------|
| D3 | Delayed 500 ms stake write clobbers claim / writes for dead player | 🟠 | 📝 Documented |
| NET-1 | ClientID race — `sendData` can run with `clientID = undefined` | 🟠 | ⬜ Open |
| NET-2 | clientID `0` (null display name) collides with "unclaimed" | 🟡 | ⬜ Open |
| NET-3 | Conversion/interior chains continue after death | 🟠 | ⬜ Open |
| NET-4 | Interior ray-cast fill wrong on diagonal loops | 🟠 | ⬜ Open |
| NET-5 | Death cloud cleanup is best-effort (stale ghost cells) | 🟡 | ⬜ Open |
| NET-6 | Redundant simultaneous death-cleanup writes | 🟡 | ⬜ Open |
| NET-7 | 6th+ player overwrites an active color slot | 🟠 | ⬜ Open |
| NET-8 | Respawn cell can be stolen in the last 0.1 s window | 🟡 | ⬜ Open |
| DEAD-1 | `GridClaimer` single-player pipeline dead; `updateMiniMap` colors latently broken | 🟡 | ⬜ Open |
| DEAD-2 | `UnionFindLoopDetection` empty stub component | 🟡 | ⬜ Open |
| DEAD-3 | Dead legacy GPS fields in `LocationTracker` | 🟡 | ⬜ Open |
| DEAD-4 | Dead helpers `coordsToIndex` / `indexToCoords` / `lastIdx` | 🟡 | ⬜ Open |
| TD-1 | `getData()` called every tick for nothing (post-LOG) | 🟡 | ⬜ Open |
| TD-2 | FNV hash + coord conversion + constants duplicated across files | 🟡 | ⬜ Open |
| TD-3 | `as any` reach into SyncKit `spawnedInstances` internals | 🟠 | ⬜ Open |
| TD-4 | `updateHUDText` misleading legacy param names | 🟡 | ⬜ Open |
| TD-5 | `Array(25).fill(vec2.zero())` shares one instance | 🟡 | ⬜ Open |
| TD-6 | `getCellDataReadOnly` has no cache TTL (unlike `getData`/`getMiniMapCells`) | 🟡 | ⬜ Open |
| TD-7 | Magic numbers (delays, TTL, `scale/6`) uncentralized | 🟡 | ⬜ Open |
| TD-8 | Non-strict TS: `map.has()`→`map.get()` deref without narrowing | 🟡 | ⬜ Open |
| FEAT-1 | No kill on entering enemy **claimed** territory | — | ⬜ Missing |
| FEAT-2 | No score / leaderboard | — | ⬜ Missing |
| FEAT-3 | No kill feed / death announcement | — | ⬜ Missing |
| FEAT-4 | Minimap snaps per-cell (no sub-cell indicator) | — | ⬜ Missing |

---

## Open defects

### 📝 D3 — Delayed 500 ms stake write clobbers a completed claim / writes for a dead player
- **Sev:** 🟠 Medium · **Location:** `Networker.sendData()`, enemy-stake branch,
  `delayedWrite.reset(0.5)`.
- **What/why:** When you step onto a cell staked by *another* player, the cell is pushed to
  `stakeList`, cached in `localCellState`, and given a stake visual **immediately**, but the
  cloud write is deferred 500 ms. The delay is intentional — it makes our stake land in the
  cloud *after* the killed player's `handlePlayerDeath` death-clear, so our stake wins the
  race instead of being erased. The closure captures the cell coords/value with **no
  cancellation**. (The one-shot event is now `removeEvent`'d after firing, but that only
  bounds event accumulation — it does not cancel the pending write.)
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
  (`getClaimVolumeFromPlayerID(undefined) → null`) for the home claim, which then throws in
  `Instantiator.instantiate` on `prefab.name`.
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
  `reset(0.04)`) and `claimInteriorCellsSequentially()` (50 ms chain, `reset(0.05)`). Neither
  checks `isAlive`.
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

### NET-8 — Respawn cell can be stolen in the last 0.1 s window
- **Sev:** 🟡 Low · **Location:** `LocationTracker.handleRespawnCountdown()` — the read
  (`getCellDataReadOnly`) and the respawn `sendData` are one tick apart.
- **Impact:** If an enemy claims the respawn cell in the 0.1 s between the final "open
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
  `horizontalAccuracy`, `verticalAccuracy`, `timestamp`, `locationSource`,
  `repeatUpdateUserLocation`, `locationService`, `hasStarted`. None are read/written;
  leftovers from a GPS-based prototype.
- **Fix hint:** Remove all ten fields.

### DEAD-4 — Dead helpers `coordsToIndex` / `indexToCoords` / `lastIdx`
- **Sev:** 🟡 Low · **Location:** `Networker.ts` — `lastIdx`, `coordsToIndex()`,
  `indexToCoords()`. Never called (the grid is a keyed `Map`, not a flat index).
- **Fix hint:** Remove.

---

## Tech debt / antipractices

### TD-1 — `getData()` is called every tick for nothing
- **Sev:** 🟡 Low · **Location:** `LocationTracker` position loop calls
  `Networker.getData(clientID, x, y)` every 0.1 s (alive branch). Its return value's only
  consumer is a `this.log(...)` (gated off by default), and its `ID` parameter is unused
  inside the body. So the call is pure per-tick overhead.
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
- **Sev:** 🟠 Medium · **Location:** `PlayerVisuals.destroyPlayerVisuals()` and
  `pruneOnDestroy()` — `(this.networkedInstantiator as any).spawnedInstances`.
- **Risk:** Depends on a private SpectaclesSyncKit map; a SDK update can silently break
  remote-player visual cleanup (dead players' cubes would persist on other devices).
- **Partially mitigated:** the map is now pruned on destroy (`destroyPlayerVisuals` deletes
  matched/stale entries; each spawn registers `networkRoot.onDestroyed` to delete its own
  entry) and reads are wrapped in try/catch — but the code still reaches `spawnedInstances`
  via `as any`, so the dependency on SDK internals remains.
- **Fix hint:** Track spawned objects ourselves (keyed by clientID/prefab) instead of reading
  SDK internals, or use a supported public API if one exists. Note: the SDK exposes no spawn
  event for *remote* spawns, so a fully self-tracked map cannot see other clients' objects —
  the scan is currently the only way to find them.

### TD-4 — `updateHUDText` misleading legacy param names
- **Sev:** 🟡 Low · **Location:** `PlayerVisuals.updateHUDText(lat, long, gridx, gridy, …)`
  is actually passed grid + world coords, not GPS. Labels in the rendered string are correct;
  only the parameter names lie.
- **Fix hint:** Rename params (e.g. `gridX, gridY, worldX, worldZ`) and drop the unused
  `latOff/longOff`.

### TD-5 — `Array(25).fill(vec2.zero())` shares one instance
- **Sev:** 🟡 Low · **Location:** `Networker.getMiniMapCells()` not-ready return — all
  25 slots reference the same `vec2`. Harmless today (read-only), a latent aliasing bug if a
  consumer ever mutates a cell.
- **Fix hint:** `Array.from({length:25}, () => vec2.zero())`.

### TD-6 — `getCellDataReadOnly` has no cache TTL
- **Sev:** 🟡 Low · **Location:** `Networker.getCellDataReadOnly()` returns any
  `localCellState` entry regardless of age, unlike `getData`/`getMiniMapCells` (5 s TTL).
  Currently safe because `localCellState` is cleared on death (its main caller is the respawn
  read, which runs while dead), but the inconsistent contract will mislead future callers.
- **Fix hint:** Apply the same 5 s TTL, or document the intentional difference at the call
  site.

### TD-7 — Magic numbers uncentralized
- **Sev:** 🟡 Low · **Location:** conversion delay `0.04`, interior delay `0.05`, delayed
  stake `0.5`, cache TTL `5000`, visual drop `scale/6`, poll `0.10`, respawn `3.0`/`0.10`.
  Scattered as literals.
- **Fix hint:** Promote to named constants (some already are in `CLAUDE.md`'s constants
  table — mirror them in code).

### TD-8 — Non-strict TS `map.has()`→`map.get()` deref
- **Sev:** 🟡 Low · **Location:** e.g. `Networker.sendData()` builds `currentCellValue` via
  `localCellState.has(k) ? localCellState.get(k) : …`, then dereferences `.x/.y`. `get()` is
  typed `vec2 | undefined`; only safe because strict null checks are off.
- **Fix hint:** Bind the `get()` result to a local and null-check it (works regardless of TS
  strictness).

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
  (`killerID === deadPlayerID` ⇒ voluntary leave or out-of-bounds death).
- **FEAT-4 — Sub-cell minimap indicator:** the minimap snaps on cell-boundary crossings; a
  fractional-position marker would smooth it.

---

## Cross-reference to `CLAUDE.md` (functionality context)

| Topic | `CLAUDE.md` section |
|-------|---------------------|
| Position loop, respawn countdown, out-of-bounds death, IDs | "Script Architecture → `LocationTracker.ts`" |
| Cell format, `sendData` decision tree, death handling, respawn, bounds | "`Networker.ts`" |
| Stake→claim conversion, interior fill | "Stake → claim conversion pipeline" / "Interior fill algorithm" |
| `currentValue` vs `currentOrPendingValue` gotcha | "Networking Architecture → Reading lazily-subscribed properties" |
| Visual spawning, minimap, arrow, HUD, respawn text | "`PlayerVisuals.ts`" |
| Player identity, color cycling | "Player Identity & Color Cycling" |
| Full open-issue prose | "Known Incomplete Areas" |
| Submission blockers (IP, safety, metadata) | "Lens Publication — Known Submission Blockers" |
