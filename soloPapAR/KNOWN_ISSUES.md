# KNOWN_ISSUES.md — Defect & Tech-Debt Register

> Status-tracked companion to `CLAUDE.md`. `CLAUDE.md` documents **how the system works**
> (architecture, data flow, coordinate systems); this file tracks **what's still wrong or
> incomplete** and where to fix it.
>
> **Policy:** when an item is resolved, **remove it from this register** (git history keeps the
> detail) and mirror the change into the relevant `CLAUDE.md` section. This file lists only
> open/documented/missing work — no "resolved" archive, to keep it scannable.
>
> **Last updated:** 2026-07-12
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
**Status:** 📝 Documented (not fixed) · ⬜ Open · ⬛ Missing (design gap)

---

## Status summary

| ID | Title | Sev | Status |
|----|-------|-----|--------|
| NET-2 | clientID `0` (null display name) collides with "unclaimed" | 🟡 | ⬜ Open |
| NET-5 | Death cloud cleanup is best-effort (stale ghost cells) | 🟡 | ⬜ Open |
| NET-6 | Redundant simultaneous death-cleanup writes | 🟡 | ⬜ Open |
| NET-8 | Respawn cell can be stolen in the last 0.1 s window | 🟡 | ⬜ Open |
| NET-9 | Stepping on your own stake trail kills you (undocumented self-collision) | 🟡 | ⬜ Open |
| NET-10 | Initial-spawn home claim overwrites an occupied cell (ungated, unlike respawn) | 🟡 | ⬜ Open |
| DEAD-1 | `GridClaimer` single-player pipeline dead; `updateMiniMap` colors latently broken | 🟡 | ⬜ Open |
| DEAD-2 | `UnionFindLoopDetection` empty stub component | 🟡 | ⬜ Open |
| DEAD-3 | Dead legacy GPS fields in `LocationTracker` | 🟡 | ⬜ Open |
| DEAD-4 | Dead helpers `coordsToIndex` / `indexToCoords` / `lastIdx` | 🟡 | ⬜ Open |
| TD-1 | `getData()` called every tick for nothing (post-LOG) | 🟡 | ⬜ Open |
| TD-2 | FNV hash + coord conversion + constants duplicated across files | 🟡 | ⬜ Open |
| TD-3 | `as any` reach into SyncKit `spawnedInstances` — now encapsulated; dependency irreducible | 🟡 | 📝 Documented |
| TD-4 | `updateHUDText` misleading legacy param names | 🟡 | ⬜ Open |
| TD-5 | `Array(25).fill(vec2.zero())` shares one instance | 🟡 | ⬜ Open |
| TD-6 | `getCellDataReadOnly` has no cache TTL (unlike `getData`/`getMiniMapCells`) | 🟡 | ⬜ Open |
| TD-7 | Magic numbers (delays, TTL, `scale/6`) uncentralized | 🟡 | ⬜ Open |
| TD-8 | Non-strict TS: `map.has()`→`map.get()` deref without narrowing | 🟡 | ⬜ Open |
| TD-9 | Gated logging still builds the log string on every call (hot-path perf) | 🟡 | ⬜ Open |
| TD-10 | Unbounded `gridCells` subscription growth (churn fixed; 1600 ceiling remains) | 🟡 | ⬜ Open |
| FEAT-1 | No kill on entering enemy **claimed** territory | — | ⬛ Missing |
| FEAT-2 | No score / leaderboard | — | ⬛ Missing |
| FEAT-3 | No kill feed / death announcement | — | ⬛ Missing |
| FEAT-4 | Minimap snaps per-cell (no sub-cell indicator) | — | ⬛ Missing |

---

## Open defects

### NET-2 — clientID `0` collides with the "unclaimed" sentinel
- **Sev:** 🟡 Low · **Location:** `LocationTracker.getDeterministicPlayerId()` returns `0`
  for a null display name; cell `.x/.y === 0` means unclaimed/unstaked.
- **Impact:** A player who joins with a null display name has `clientID = 0`, so their own
  claims read as "unclaimed" in `sendData`'s decision tree — they perpetually re-stake their
  own territory and never trigger loop closure. `Networker.computeClientID` already guards
  the *leave* path (skips cleanup when hash is 0), but the join path is unguarded.
- **Fix hint:** Map a 0 hash to a non-zero fallback, or reject/replace null display names.

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
- **Impact:** Each remaining client independently writes the same per-component clear
  (`vec2(x === ID ? 0 : x, y === ID ? 0 : y)` — zeroes only the dead player's own claim/stake,
  preserving another player's value in the cell) to the same cells — idempotent but
  O(remaining players × dead player's subscribed cells) redundant traffic.
- **Fix hint:** Elect a single cleaner (e.g., lowest clientID present) or rely on the killer
  only.

### NET-8 — Respawn cell can be stolen in the last 0.1 s window
- **Sev:** 🟡 Low · **Location:** `LocationTracker.handleRespawnCountdown()` — the read
  (`getCellDataReadOnly`) and the respawn `sendData` are one tick apart.
- **Impact:** If an enemy claims the respawn cell in the 0.1 s between the final "open
  ground" check and the respawn, the forced home claim silently overwrites their claim.
  Related: the respawning player's color can change if another player grabbed their freed
  slot during the dead window (see `respawn()` → `assignAndWritePlayerID`).
- **Fix hint:** Re-verify the cell is open at the instant of respawn before writing the home
  claim; if not, extend the countdown one more tick.

### NET-9 — Stepping on your own stake trail kills you (undocumented self-collision)
- **Sev:** 🟡 Low · **Location:** `Networker.sendData()`, the `if (stakedBy != 0)` branch
  (~line 381). `gridSyncEntity.sendEvent(deathEventString, vec2(stakedBy, clientID))` fires
  *before* the `if (stakedBy !== this.clientID)` guard, so it also fires when the stake is
  your own.
- **What/why:** Every unclaimed cell you walk is staked by you (`sendData`'s `else` branch).
  If your trail self-intersects — you re-enter a cell you already staked *this life* without
  having returned to your claim — then `currentCellValue.y === this.clientID`, so
  `stakedBy != 0` is true and the death RPC fires as `vec2(clientID, clientID)`, running
  `handlePlayerDeath(clientID)` on every client (local death path on your device). This is
  Paper.io-correct self-collision, but it is **not documented** as a mechanic and the
  surrounding code/comment frame the branch as killing *enemies* ("killing whoever owns that
  stake").
- **Impact / repro:** (1) Walk a self-crossing path (stake A→B→C→D, then step back onto B) →
  instant self-death. Reproducible; likely intended, but confirm it's wanted. (2) The death
  payload `killerID === deadPlayerID` is **identical** to the voluntary-leave / out-of-bounds
  payload — `killLocalPlayer()` sends `vec2(clientID, clientID)` and the `onUserLeftSession`
  path derives the same shape. A future kill feed (FEAT-3) therefore cannot distinguish
  "crossed own trail" from "left the game." (3) Re-entering a cell you just staked *over an
  enemy* (the enemy-stake branch caches `vec2(claimedBy, yourID)` locally) triggers the same
  self-death on the next entry.
- **Fix hint:** If self-collision is intended, document it in `CLAUDE.md`'s `sendData`
  decision tree and give it a distinct payload/flag so the kill feed can label it. If it is
  **not** intended, move the `sendEvent` inside the `if (stakedBy !== this.clientID)` guard so
  stepping on your own trail is a no-op. Related: FEAT-3, NET-10.

### NET-10 — Initial-spawn home claim overwrites an occupied cell (ungated, unlike respawn)
- **Sev:** 🟡 Low · **Location:** `Networker.sendData()` `firstClaim` branch (~line 356).
- **What/why:** The `firstClaim` branch writes `vec2(ID, 0)` **unconditionally** — it never
  reads the cell's current `claimedBy`/`stakedBy`. Respawn is protected because
  `LocationTracker.handleRespawnCountdown` blocks until the player stands on an open,
  in-bounds cell before calling `sendData` (the countdown resets on any claimed/staked/OOB
  cell — see NET-8). The **first** join has no such gate: `firstClaim` is armed from
  construction and fires on the first cell the player occupies once `gridReady` is true.
- **Impact / repro:** Join (or start) while standing on a cell already claimed or staked by
  another player → your home claim silently erases their claim (`vec2(ID, 0)` clobbers
  `vec2(enemyID, …)`) and ignores their stake (no kill for either player, no self-death).
  Low likelihood in open play, trivially reproducible when two players start co-located.
  Same family as NET-8 but at join time and currently ungated.
- **Fix hint:** Before writing the home claim, read the current cell; if
  `claimedBy !== 0 || stakedBy !== 0`, defer the claim (leave `firstClaim = true`) until the
  player reaches an open cell — mirroring the respawn "open ground" rule. Best done by
  extracting the shared "is this a legal spawn cell?" predicate that
  `handleRespawnCountdown` already applies, so join and respawn agree.

---

## Dead / broken code

### DEAD-1 — `GridClaimer` single-player pipeline is dead; `updateMiniMap` colors latently broken
- **Sev:** 🟡 Low · **Location:** `GridClaimer.ts` (whole component's runtime path);
  `PlayerVisuals.updateMiniMap()` / `renderMiniMapCell()` / `getCellColor()` /
  `createUICell()`.
- **Detail:** `GridClaimer` is no longer wired into the scene — its import/usage in
  `LocationTracker` is commented out and `updatePos()` (the only caller of `updateMiniMap`, via
  `GridClaimer.ts`) is never invoked — so this entire local-`SparseGrid` render path is
  unreachable. `Networker` + `updateMiniMapNetworked` superseded it. If ever re-enabled, `getCellColor`
  returns 0–255 `vec4`s (e.g. `new vec4(255,0,0,0.5)`) where shaders expect 0–1 — it would
  render fully clipped. `SparseGrid` and `CellState` are still legitimately imported/used and
  should stay.
- **Fix hint:** Delete the dead render methods and the `GridClaimer` component's game logic,
  keeping `SparseGrid`/`CellState` if still needed, or drop `GridClaimer` from the scene.

### DEAD-2 — `UnionFindLoopDetection` empty stub
- **Sev:** 🟡 Low · **Location:** `UnionFindLoopDetection.ts` — `LoopDetection` compiles to a
  no-op `BaseScriptComponent`; its whole body is commented out (abandoned in favor of the
  flood-fill in `Networker.findAndFillEnclosedRegion()`).
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
  consumer is a `this.log(...)` (gated off by default), and its `ID` parameter is used only
  inside log statements (never functionally). So the call is pure per-tick overhead when
  logging is off.
- **Fix hint:** Delete the per-tick `getData` call (and the log-only `ID` param), or keep it
  only inside an `if (showLogs)` guard.

### TD-2 — Duplicated hash / coordinate conversion / constants
- **Sev:** 🟡 Low · **Location:** FNV-1a hash in both
  `LocationTracker.getDeterministicPlayerId` and `Networker.computeClientID`;
  `worldCoordsToGridPos` in `LocationTracker` + `GridClaimer` and `gridPosToWorldCoords` in
  `Networker` + `GridClaimer` (each pair duplicated, not all three files); `unitsPerCell = 200`
  in all three grid files, `gridRadius = 20` as a literal in `LocationTracker` / `GridClaimer`
  (derived as `height / 2` in `Networker`), `height = 40` only in `Networker`.
- **Risk:** Any change must be made in 2–3 places; silent divergence.
- **Fix hint:** Extract a shared `GridMath`/`PlayerId` util module.

### TD-3 — `as any` reach into SyncKit `spawnedInstances` (encapsulated; dependency irreducible)
- **Sev:** 🟡 Low · **Status:** 📝 Documented · **Location:** `PlayerVisuals.getSpawnedInstances()`
  (the single audited `(this.networkedInstantiator as any).spawnedInstances` access),
  consumed by `forEachSpawnedInstance()` / `deleteSpawnedInstance()` /
  `destroyPlayerVisuals()` / `pruneOnDestroy()`.
- **Why it can't be eliminated (research verdict):** the Instantiator exposes no public
  enumerator, no by-owner/by-id lookup, and fires **no callback for remote spawns**
  (`onSuccess` is local-only). PapAR's claim/stake objects are spawned **unowned**, so
  `ownerInfo`/`getOwnerId()` are null — player identity lives solely in the `_prefab_name`
  prefix (`"P{visualID}…"`). `SessionController` exposes the stores but not their
  `SceneObject`s. So scanning the private `spawnedInstances` map is the only way to reach
  another player's spawned objects; "track it ourselves" cannot see remote spawns.
- **What was done (hardening):** the `as any` now lives in exactly one helper
  (`getSpawnedInstances`) that warns loudly and returns `null` if the map disappears (SDK
  changed). Iteration/deletion go through `forEachSpawnedInstance`/`deleteSpawnedInstance`,
  which tolerate **both** the current representation (a `Map` object whose entries are stored
  as plain-object properties → enumerate with `for..in`) and a hypothetical future real-`Map`
  (`.forEach()`/`.delete()`). Deliberately not `instanceof Map`-based — the current map *is* a
  `Map` instance but `.forEach()` visits zero of its property-stored entries.
- **Residual risk:** still coupled to an SDK private field; a rename/removal disables
  remote-player visual cleanup (now fails loud, not silent). No further action planned unless
  the SDK gains a public API.

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
  Two callers: `LocationTracker.handleRespawnCountdown` (runs while dead — safe because
  `localCellState` is cleared on death) and `Networker.findAndFillEnclosedRegion` (the flood-fill
  barrier check, runs while alive during a conversion — safe because it reads cells this life just
  wrote). Both are currently safe, but the inconsistent contract will mislead future callers.
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

### TD-9 — Gated logging still builds the log string on every call (hot-path perf)
- **Sev:** 🟡 Low · **Location:** `log(msg: string)` in `Networker`, `LocationTracker`, and
  `PlayerVisuals` (plus raw `print()` calls in `GridClaimer`). The `showLogs` check lives
  *inside* `log()`, so every `this.log("…" + a + "…" + b)` fully evaluates and concatenates
  its string argument **before** the call — the guard only suppresses the `print()`, not the
  string construction.
- **Risk / impact:** On the 10 Hz position loop this is per-tick allocation/CPU on a
  memory- and CPU-constrained Spectacles device even with `showLogs = false`. Worst
  offenders: `getData()` (~10 concatenations, called *every* tick — see TD-1);
  `sendData()`; and the per-cell `onAnyChange` listener registered in `getCellProperty`
  (~lines 146–156), which builds several strings on **every** cloud cell change and fires
  heavily during bulk conversion and remote updates. (`getMiniMapCells` now touches its 25
  cells only on a redraw, not every tick — see TD-10 — so it is no longer a per-tick offender.)
  Compounds with TD-10 (more subscribed cells → more `onAnyChange` string-building).
- **Fix hint:** Guard hot call sites with `if (this.showLogs) this.log(...)`, or change
  `log()` to accept a thunk (`log(() => "…")`) invoked only when enabled. The single biggest
  win is deleting the per-tick `getData()` call outright (TD-1), which removes both the
  useless read and its ~10 concatenations. Broader form of TD-1.

### TD-10 — Unbounded `gridCells` subscription + listener growth (churn fixed; ceiling remains)
- **Sev:** 🟡 Low · **Location:** `Networker.getCellProperty()` (~line 131), driven by
  `getMiniMapCells()`.
- **Churn now fixed:** the minimap is event-driven (`shouldRedrawMiniMap` gate in
  `LocationTracker`), so `getMiniMapCells` → `getCellProperty` no longer runs every tick — it
  runs only on a redraw (window shift or a windowed cell change). New cells are therefore
  subscribed at most once per cell-*entry*, not 10×/second. This was the item's own recommended
  fix ("subscribe only on actual cell entry rather than for every ±2 look").
- **Residual (ceiling unchanged):** the first touch of a cell still creates a `StorageProperty`
  + cloud subscription + `onAnyChange` listener that is **never removed** (no supported
  un-subscribe in SyncKit), so a player traversing much of the 40×40 arena still accretes
  toward the ~1600-cell ceiling over a long session — just far more slowly. Distinct from NET-5
  (stale *cloud values*); this is about local subscription/listener cost.
- **Fix hint (residual only):** reuse a fixed pool of 25 properties keyed to the visible window,
  or accept the finite 1600 ceiling. Measure on-device (frame time, memory) before investing.

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
