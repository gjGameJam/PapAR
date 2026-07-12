# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**soloPapAR** is a Paper.io-inspired AR game for **Snap Spectacles** (AR glasses), built in **Snap Lens Studio 5.12.1** using **TypeScript**. Players physically walk in the real world to stake trails, loop back to their own territory, and convert the enclosed area into permanent claims. The AR grid and all player objects are overlaid on the physical world at 1:1 scale (2 meters per cell). Stepping on another player's stake trail kills its owner; a killed player (or one who leaves) is cleaned up on every client, then — after a 3-second respawn countdown — rejoins with a fresh home claim.

There are no CLI build commands. Development happens by opening `soloPapAR.esproj` in Lens Studio and previewing on a Spectacles device or the built-in emulator. All non-TypeScript assets (prefabs, materials, shaders, `.meta` files) are managed entirely within the Lens Studio IDE; most are binary or Lens Studio YAML and should not be hand-edited.

**Git LFS** is active: all `Assets/**/*` go through LFS except TypeScript, JSON, GLSL, and a handful of other text formats listed in `.gitattributes`.

---

## Repository Structure

```
soloPapAR/
├── soloPapAR.esproj               # Lens Studio project file (YAML)
├── Assets/
│   ├── GrantWork/
│   │   ├── Scripts/               # All custom TypeScript — the entire game logic
│   │   │   ├── LocationTracker.ts
│   │   │   ├── Networker.ts
│   │   │   ├── PlayerVisuals.ts
│   │   │   ├── GridClaimer.ts     # Legacy — SparseGrid + CellState still imported
│   │   │   └── UnionFindLoopDetection.ts  # Stub, fully commented out
│   │   ├── Volumes/
│   │   │   ├── P1–P5 ClaimCube / StakeCube / StakePillar  (.prefab)
│   │   │   ├── Materials/         # P1–P5 Claim / Stake / Pillar materials (.mat)
│   │   │   └── Shaders/           # P1–P5 Claim / Stake / Pillar shaders (.ss_graph)
│   │   └── GameLocation.location  # Snap location anchor asset
│   └── ...                        # HDR env, device camera texture, base image
└── SpectaclesSyncKit.lspkg/       # Networking package (imported as package, not asset)
```

---

## Script Architecture

Three active `BaseScriptComponent` classes drive the game — `LocationTracker`, `Networker`, `PlayerVisuals` — each attached to a scene object and wired together via `@input` fields. Two more classes are documented below but inactive: `GridClaimer` (legacy, being phased out) and `UnionFindLoopDetection` (defunct stub).

### `LocationTracker.ts` — Entry point / position polling

**Lifecycle**: `onAwake()` registers two independent callbacks:
- `SessionController.notifyOnReady()` → sets `clientID` (from FNV-1a hash of display name) and calls `Networker.setPlayerID(clientID)`.
- `networkedInstantiator.notifyOnReady()` → starts the position loop by calling `getDeviceTrackerPosition()`.

The two callbacks are independent — the position loop can start before `clientID` is set if the instantiator becomes ready before the session controller. The loop guards against this: after updating the HUD and minimap (neither needs `clientID`), each tick early-returns (rescheduling itself) while `this.clientID == null`, so the stake/claim/respawn branch never runs — and `sendData()`/`getData()`/`handleRespawnCountdown()` are never called — until `clientID` is assigned.

**Position loop**: A `DelayedCallbackEvent` that self-resets every **0.1 seconds**, continuously calling itself via `getNewPosition.reset(0.10)`. On each tick it:
1. Reads `playerTracker.getTransform().getWorldPosition()` (AR world space, cm)
2. Converts to grid coords via `worldCoordsToGridPos()`
3. Calls `PlayerVisuals.updateHUDText()` every tick
4. **Event-driven minimap redraw**: calls `Networker.shouldRedrawMiniMap(gridPos.x, gridPos.y)` (a cheap guard) and only when it returns true does it call `Networker.getMiniMapCells()` → `PlayerVisuals.updateMiniMapNetworked()`. A redraw fires only when the player crosses into a new cell (the 5×5 window shifts) or a cell **inside the current window** changed value (`Networker.miniMapDirty`, set by `updateCellValue` on local writes and by the `onAnyChange` listener on remote cloud updates). While the player stands still and nothing in-window changes, the minimap does no per-tick read or recolor.
5. **Branches on alive/dead state** (this branch only runs once `Networker.gridReady` is true):
   - **Dead** (`!Networker.isAlive`): calls `handleRespawnCountdown(gridPos, worldPosition)` — the respawn path (see below). The normal `getData`/`sendData` flow is skipped entirely while dead.
   - **Alive**: first checks bounds — if the grid position is outside the 40×40 arena (`!Networker.isInBounds()`), calls `Networker.killLocalPlayer()` (leaving the play area is fatal) and skips the rest of the tick. Otherwise calls `Networker.getData(clientID, gridPos.x, gridPos.y)` — result is used only for debug logging (`this.log("cell: " + gridPos + ...)`), not for game logic — then only calls `Networker.sendData()` if the player has moved to a **new cell** (checked by `PlayerVisuals.isInSameCell()`).

Step 3 (HUD) runs **every** tick regardless of alive/dead. Step 4 (minimap) runs every tick but is gated by `shouldRedrawMiniMap`, so it only *redraws* on an actual change — a dead player still sees the live map because a windowed cell change (or their own movement toward open ground) still triggers a redraw. This minimap block must stay **above** the alive/dead branch: `handleRespawnCountdown` reads the current cell via `getCellDataReadOnly` (which does not subscribe), and `getMiniMapCells` is what keeps the player's cell subscribed whenever the window center changes. The `gridReady` guard must wrap the `isInSameCell` call — `isInSameCell` has the side effect of updating `prevGridPos` on every false return, so calling it before `gridReady` would permanently consume the player's starting cell entry without placing a home claim.

Note: `sendData()` performs its own independent read of the cell state — it does **not** use the return value from the `getData()` call above.

**Respawn countdown** (`handleRespawnCountdown(gridPos, worldPosition)`): Runs once per 0.1s tick while the local player is dead. State lives in three private fields on `LocationTracker`: `respawnCountdown` (seconds remaining; `-1` = inactive), `respawnDuration = 3.0`, and `respawnTick = 0.10` (must match the loop interval). Each tick:
1. Reads the current cell via `Networker.getCellDataReadOnly(gridPos.x, gridPos.y)` — a side-effect-free read that registers no subscription. `cell.x != 0` = claimed, `cell.y != 0` = staked.
2. Computes `outOfBounds = !Networker.isInBounds(...)`. If the countdown is inactive (`< 0`) **or** the player is `blocked` — standing on a claimed/staked cell (`inTerritory`) **or** outside the arena (`outOfBounds`) — resets `respawnCountdown` to the full `respawnDuration`. This prevents respawning in an OP position (inside enemy territory / on a live stake) **and** prevents respawning off-grid: off-grid cells read as open (`vec2.zero()`), so without the bounds check a player who died by leaving would respawn outside the arena. Otherwise decrements by `respawnTick`.
3. When `respawnCountdown <= 0`: resets it to `-1`, calls `PlayerVisuals.hideRespawnCountdown()`, calls `Networker.respawn()`, then syncs `prevGridPos` via `PlayerVisuals.isInSameCell(gridPos)` and calls `Networker.sendData()` directly. Because `respawn()` re-armed `firstClaim`, this immediate `sendData()` places a fresh home claim at the current (guaranteed-open) cell — exactly the same code path as the initial spawn. Syncing `prevGridPos` first means the next normal tick won't re-fire `sendData()` unless the player actually moves.
4. Otherwise calls `PlayerVisuals.showRespawnCountdown(Math.ceil(respawnCountdown), blocked, outOfBounds)` to update the on-screen timer.

Because the countdown starts at 3.0s and decrements by `respawnTick` (0.1s) each tick, the display holds "3", "2", "1" for ~1s each (~3s total). While the timer is frozen the display switches to "Move to open ground" (on claimed/staked territory) or "Return to the play area" (outside the arena).

**Player ID assignment**: On `SessionController.notifyOnReady()`, the local Snapchat display name is hashed via `getDeterministicPlayerId()` (FNV-1a) to produce `clientID`, then `Networker.setPlayerID(clientID)` is called (single argument). The visual color index `playerID` is **not** derived from a user count — it's assigned separately by `Networker.assignAndWritePlayerID()` via color-slot scanning once the grid is ready.

**Rotation**: `getDeviceTrackerRotation()` extracts yaw from the device quaternion using the standard formula and normalizes to `[0, 2π]`. This is called from `PlayerVisuals.onUpdate()` every frame.

**Key `@input` fields**: `playerTracker: DeviceTracking`, `Networker`, `networkedInstantiator: Instantiator`, `PlayerVisuals`

---

### `Networker.ts` — All game state and logic

This is the authoritative game logic script. It owns the entire cloud grid, manages the Paper.io rule set, drives stake/claim conversion, and handles death.

#### Initialization sequence

`onAwake()` creates `gridSyncEntity = new SyncEntity(this)`. When the entity is ready (`notifyOnReady`), `gridReady = true` and `initializeGridCells()` is called. `initializeGridCells()` registers the five `playerColorSlot_*` StorageProperties (for player color mapping) and flushes any pending color write if `setPlayerID()` was called before the grid was ready. All grid cell properties are still created lazily on first access.

Two additional listeners are registered in `onAwake()` unconditionally (before `gridReady`):
- **Death RPC listener** (`playerDeathEvent`): fires on ALL clients whenever any player dies; calls `handlePlayerDeath(deadPlayerID)` unconditionally — no client-ID guard.
- **`SessionController.onUserLeftSession`**: fires on all remaining clients when a peer disconnects. Hashes `userInfo.displayName` via `computeClientID()` (same FNV-1a as `LocationTracker`) to recover the leaving player's `clientID`, then calls `handlePlayerDeath(leftClientID)` directly (no RPC needed — the event fires locally on each remaining device).

#### Player ID fields

- `clientID: number` — the FNV-1a hash of the Snapchat username (unique per player, persists across sessions)
- `playerID: number` — visual color set index `1–5`; assigned by `assignAndWritePlayerID()` and stable for the cloud session **unless the player dies, leaves, or respawns** (see Player color mapping below)

#### Player color mapping

Five `StorageProperty<vec2>` slots (`playerColorSlot_1` through `playerColorSlot_5`) are registered at grid-ready time. Each stores `vec2(clientID, playerID)`. `playerID` determines which slot is used (slot index = `playerID - 1`).

Assignment is handled by `assignAndWritePlayerID()`, called once `gridReady` is true and `clientID` is known (whichever happens last):
1. **Rejoin detection**: scan all 5 slots for a matching `clientID`. If found, reuse the stored `playerID` — no cloud write needed. This guarantees a returning player always gets their original color.
2. **New player**: scan for the first empty slot (`currentValue.x === 0`), starting from `clientID % 5` to reduce simultaneous-join collisions. Claim it with `setPendingValue(vec2(clientID, slotIdx+1))`.
3. **All slots full** (6+ players, none ours): take a **local-only** shared fallback color `(clientID % 5) || 5` and **do not write the cloud slot** — overwriting an occupied slot would corrupt that player's color mapping on every client. `getPlayerVisualID()` derives the same value for any player without a slot, so remote coloring stays consistent. Accepted tradeoff: this player shares a color with an active player, and because remote cleanup matches by the `"P{visualID}"` prefix, their death can also destroy the co-colored player's cubes on remote clients.

**Slot freeing on death/leave**: `handlePlayerDeath` scans slots and writes `vec2.zero()` to the slot whose `currentValue.x` matches the dead player's clientID. This runs on all remaining clients simultaneously (idempotent). A player who fully **leaves** and rejoins later will no longer find their old slot and will be assigned a new one — intentional, since leaving is treated as permanent death. A **respawn** is different: `respawn()` immediately re-runs `assignAndWritePlayerID()`, which — because its empty-slot search is seeded from `clientID % 5` — usually re-claims the same slot (and therefore the same color) that death just freed. The color only changes if another player grabbed that slot during the dead window.

`getPlayerVisualID(clientID)` scans the five slots for a matching `clientID` and returns its `playerID` (1–5). Falls back to `(clientID % 5) || 5` if no slot has been written yet for that player. **Must use `currentValue`** (not `currentOrPendingValue`) when reading slots — `silentSetCurrentValue` only sets `currentValue`, so slots written by remote players before this client subscribed would read as `vec2.zero()` via `currentOrPendingValue`, causing incorrect color assignment. The local player's own `playerID` is returned directly from `this.playerID` via a fast-path check, bypassing the slot lookup entirely.

#### Cell data format

Each cell is stored as a `StorageProperty<vec2>`:
- `.x` = `claimedByID` (0 = unclaimed)
- `.y` = `stakedByID` (0 = not staked)

A cell can simultaneously have a non-zero claim AND a non-zero stake (player staking over enemy territory). Keys follow the pattern `"cell_x_y"` (e.g. `"cell_22_18"`).

#### `sendData(ID, xpos, zpos, realWorldCoords)` — The main game loop

Called by `LocationTracker` each time the player enters a new cell. Guards: returns early if `!isAlive` or `isPerformingBulkConversion` or `!gridReady`.

Decision tree (in order):
1. **`firstClaim == true`**: Write `vec2(ID, 0)` as the home claim, spawn a claim visual, set `firstClaim = false`, return early.
2. **`stakedBy != 0`**: The cell has someone's stake in it. Fire `playerDeathEvent` RPC with `vec2(stakedBy, clientID)` — killing whoever owns that stake (this fires *before* the self-check, so stepping on your own trail self-kills — see `KNOWN_ISSUES.md` NET-9). Then, **only if the stake is another player's** (`stakedBy !== clientID`), also claim the cell for yourself: push to `stakeList`, update `localCellState`, and spawn a stake visual **immediately**, but **defer the cloud write 500 ms** so it lands *after* the killed player's death-clear (otherwise their clear would erase it). That deferred write captures `conversionEpoch` and **no-ops if the epoch changed** — i.e. if you looped back to your own claim (a conversion) or died within the 500 ms — so it can't revert a just-converted claim back to a stake, nor write a stake for a dead player (fixes former defect D3).
3. **`claimedBy == ID`**: Player stepped onto their own claimed territory. Call `addStakedRegionToClaim()` to convert the pending trail.
4. **Else** (unclaimed or enemy-claimed): Push `vec2(xpos, zpos)` to `stakeList`, write `vec2(existingClaim, ID)` to cloud (immediately), spawn a stake visual.

#### Stake → claim conversion pipeline

`addStakedRegionToClaim()` → guarded by `isPerformingBulkConversion` (boolean mutex).

Steps:
1. Set `isPerformingBulkConversion = true`, **bump `conversionEpoch`**, and capture `const epoch = this.conversionEpoch`. (Bumping here also cancels any still-pending 500 ms enemy-stake write from this trail — every staked cell is in `stakeList` and thus in this batch, so those deferred writes must not fire.)
2. Call `PlayerVisuals.DestroyAllStakes()` immediately
3. Copy `stakeList` to `stakesToConvert`, then clear `stakeList`
4. Call `convertStakesSequentially(stakesToConvert, 0, realWorldCoords, epoch, onComplete)`
5. In `onComplete`: call `findAndFillEnclosedRegion(stakesToConvert, realWorldCoords, epoch)`, then set `isPerformingBulkConversion = false`

`convertStakesSequentially(stakes, index, realWorldCoords, epoch, onComplete)` processes one stake per call. For each stake it:
- **Aborts (returns without calling `onComplete`) if `conversionEpoch !== epoch`** — a death or a newer batch superseded this chain; this stops it spawning claim visuals / writing cells for a dead or superseded life (fixes former defect NET-3).
- Reads current cloud value, writes `vec2(clientID, 0)` (claim = self, stake = cleared)
- Spawns a claim visual at that position
- Sets a `DelayedCallbackEvent` of **40ms** before processing the next stake (threading `epoch` through)
- Skips ahead on failure without aborting the batch

`claimInteriorCellsSequentially()` works identically (same `epoch` param + abort guard) but uses **50ms** delays per interior cell.

**`conversionEpoch`** is a monotonic counter bumped on death (`handlePlayerDeath` local phase) and at each conversion-start. Both sequential chains and the deferred enemy-stake write capture it and self-abort when it changes. Because chains tick every 40–50 ms and the death bump is immediate, an in-flight chain aborts on its very next tick — long before the 3 s respawn — so it can never interleave writes with the new life's home claim. This works even across a respawn (where `isAlive` flips back to `true`), which a plain `!isAlive` guard could not.

#### Interior fill algorithm

`findAndFillEnclosedRegion(loop, realWorldCoords, epoch)` uses **exterior flood fill** (NET-4). Enclosure on a discrete grid is a connectivity question ("can this cell reach the outside without crossing my boundary?"), not the crossing-parity question the old point-in-polygon ray-cast (`isInLoop`/`getLoopEdges`, removed from `Networker` — they still physically exist in the legacy `GridClaimer.ts`) answered — that ray-cast treated cells as idealized points and left squares beside diagonal edges unfilled.

1. Compute the bounding box `[minX, maxX] × [minZ, maxZ]` of the stake loop; early-return if `loop.length < 4` or `maxX - minX <= 1 || maxZ - minZ <= 1` (no interior possible).
2. **Build a barrier** `Set<number>` (key = `x * height + z`; only in-bounds cells) of cells the fill can't cross:
   - **(a) the trail**, densified with a `bresenhamLine()` between consecutive cells so a fast/diagonal step that skips >1 cell in one 0.1 s tick can't leave a hole. Added **unconditionally** (never gated on a cell read) so the seal always holds. **No `last→first` edge** — closure comes from (b).
   - **(b) my existing claimed cells** in the bbox (`getCellDataReadOnly(x, z).x === clientID`), which seal the gap between the trail's first and last cells through real territory. Enemy-owned cells are intentionally **not** barriers, so an enemy cell trapped inside the loop is captured and overwritten to me.
3. **Flood the exterior** with a **4-connected** BFS over the bbox expanded by one cell (a guaranteed-outside ring). 4-connectivity is required so a diagonal (8-connected) barrier seals — the flood can't slip through the corner-touch between two diagonally adjacent barrier cells (an 8-connected flood would leak and fill nothing). Out-of-grid neighbors count as exterior, so a loop hugging the arena edge fills correctly (the edge is open, not a claimable wall — consistent with out-of-bounds = death). Seed from every in-bounds non-barrier cell on the ring or adjacent to the grid edge.
4. **Interior** = every in-bounds cell in the full bbox that is neither barrier nor exterior. Claim them via `claimInteriorCellsSequentially()` (unchanged 50 ms async chain + `epoch` abort guard).

Complexity is O(bbox area) ≤ ~42×42, run once per loop closure; the flood itself is synchronous, only the claim writes stay async.

#### Death handling

**Two triggers** both route to `handlePlayerDeath(ID)` on every remaining client:

1. **In-game kill**: `sendData()` fires an RPC when a player steps on an enemy stake trail:
   ```
   gridSyncEntity.sendEvent('playerDeathEvent', vec2(stakedBy, clientID))
   ```
   All clients receive this and call `handlePlayerDeath(deadPlayerID)` with no guard — the old `if (deadPlayerID === clientID)` check has been removed.

2. **Player leaves**: `SessionController.onUserLeftSession` fires on each remaining device. `computeClientID(userInfo.displayName)` re-derives the leaving player's clientID via the same FNV-1a hash used at join time, then calls `handlePlayerDeath(leftClientID)` directly. No RPC is needed because the event fires independently on every remaining device.

`handlePlayerDeath(ID)` — three phases (all clients run all three):

**Phase 1 — Local-only** (`if ID === this.clientID`):
- `isAlive = false`, `firstClaim = true`, `stakeList = []`
- **`conversionEpoch++`** and **`isPerformingBulkConversion = false`** — invalidates any in-flight conversion/interior chain and pending deferred stake write from this now-dead life (they self-abort on their next tick), and releases the mutex so it can't linger while dead.
- `localCellState.clear()`, `localCacheTimestamps.clear()`
- `PlayerVisuals.DestroyAllStakes()` and `PlayerVisuals.DestroyAllClaims()` — these operate on `spawnedClaims`/`spawnedStakes`, which only contain objects spawned by this device, so they are the correct teardown path for self-death.

**Phase 2 — Remote-player visual cleanup** (`else`, guarded by `gridReady`):
- `PlayerVisuals.destroyPlayerVisuals(ID, getPlayerVisualID)` — iterates the Instantiator's internal `spawnedInstances` map (through the encapsulated accessor trio; see `PlayerVisuals.ts` / `KNOWN_ISSUES.md` TD-3) to find and destroy all scene objects whose `_prefab_name` store key starts with `"P" + visualID`. This covers every device: the Instantiator tracks all spawned objects locally on each client regardless of who spawned them.

**Phase 3 — Cloud cleanup** (all clients):
- **Cell cleanup** (guarded by `gridReady`): iterates `gridCells` — for any cell whose `currentValue.x === ID` or `.y === ID`, only the **dead player's own component** is zeroed (a per-component clear, `vec2(x === ID ? 0 : x, y === ID ? 0 : y)`, so another player's claim/stake in the same cell is preserved) via `updateCellValue(…, "DEATH CLEAR")`. Best-effort: only covers cells that have been `getCellProperty`'d on this device. Cells the dead player visited but no remaining client ever subscribed to will remain stale in the cloud until another player passes through them.
- **Color-slot free** (runs **unconditionally** — not under the `gridReady` guard; the slots array is empty before ready, so no guard is needed): scans `playerColorSlots`, finds the slot whose `currentValue.x === ID`, writes `vec2.zero()` via `setPendingValue`. This makes the color available for the next joining player.

`computeClientID(displayName: string): number` — private method on `Networker`, identical FNV-1a algorithm as `LocationTracker.getDeterministicPlayerId`. Used only in the `onUserLeftSession` handler to recover a clientID from a display name. Guards against null input (returns 0) — if the result is 0, cleanup is skipped since clientID 0 collides with the "unclaimed" sentinel.

Note: after death, `isAlive = false` prevents `sendData()` from doing anything until the player respawns (see below).

#### Respawn

`respawn()` (public, called by `LocationTracker.handleRespawnCountdown` once the countdown completes) re-enables a dead **local** player. `handlePlayerDeath`'s local-only phase already reset `firstClaim = true`, cleared `stakeList`, cleared the local caches, and destroyed the player's own visuals — so `respawn()` only needs to:
1. Return early if `!gridReady`.
2. Set `isAlive = true`.
3. Re-assert `firstClaim = true` and `stakeList = []` (defensive; already set on death).
4. Clear `isPerformingBulkConversion = false` — in case the player died mid-conversion, this stops a stale mutex from wedging future stakes.
5. Call `assignAndWritePlayerID()` to re-claim a color slot and reset `this.playerID`. This is required because `handlePlayerDeath` (Phase 3) freed the dead player's color slot on **all** clients; without re-claiming, remote clients would color the respawned player's new cells via the `(clientID % 5) || 5` fallback. The empty-slot search is seeded from `clientID % 5`, so the player almost always reclaims the same slot/color.

Respawn is entirely local — there is no cloud-side respawn state or RPC. The player's fresh home claim is **not** placed by `respawn()`; it is placed by the immediate `sendData()` call in `handleRespawnCountdown` (which hits the `firstClaim` branch now that `respawn()` re-armed it).

#### Out-of-bounds death

`isInBounds(x, y): boolean` — public; true when `(x, y)` is a valid cell in `[0, height)` (the same predicate `getMiniMapCells` uses). The grid write/read paths (`sendData`, `getCellProperty`, `getCellDataReadOnly`) do **not** self-validate bounds, so callers must gate on this.

`killLocalPlayer()` — public; kills the **local** player when they leave the arena. Guards on `gridReady && isAlive`, fires `playerDeathEvent` as `vec2(clientID, clientID)` with `onlySendRemote = true` (so remotes tear down our visuals/cells/color slot without a local echo), then calls `handlePlayerDeath(this.clientID)` directly — mirroring the `onUserLeftSession` path. `LocationTracker.getDeviceTrackerPosition` calls this from the alive branch whenever `!isInBounds(gridPos)`; the dead branch's `handleRespawnCountdown` then blocks respawn until the player returns in-bounds onto open ground.

#### Cloud storage & local cache

**Lazy property creation** via `getCellProperty(x, y)`: checks `gridCells` Map first; if missing, creates `StorageProperty.manualVec2("cell_x_y", vec2.zero())`, adds it to `gridSyncEntity`, attaches an `onAnyChange` listener, stores in the map.

**`updateCellValue(x, y, newValue, description)`**: the single write path. Always:
1. Uses `setValueImmediate()` if description contains `"CONVERSION"` or `"INTERIOR"` and `canIModifyStore()` is true; otherwise uses `setPendingValue()`
2. Always writes to `localCellState` map with current timestamp
3. Marks the minimap dirty (`miniMapDirty = true`) if `(x, y)` is within the current window — so local stakes/claims/conversions/interior fills appear immediately, without waiting for the cloud round-trip.

**`getData(ID, x, y)`**: read path. The `ID` parameter is used **only for logging** (an opening trace and a "still staked by ID" warning) — never for game logic; it's a legacy artifact and could be removed along with those log lines. Checks `localCellState` first (uses if cache age < **5000ms**); falls back to `cellProp.currentValue`; returns `vec2.zero()` on any error. Note: `sendData()` does NOT call `getData()` — it reads cell state directly from `localCellState`/`currentValue` internally. `getData()` is called every tick by `LocationTracker` for debug logging only.

**`getMiniMapCells(centerX, centerY)`**: public minimap data provider. Returns early with 25 `vec2.zero()` values if `!gridReady` — this prevents `getCellProperty` (and thus `addStorageProperty`) from being called before the SyncEntity is ready, which would leave `currentValue` permanently at `vec2.zero()` since SpectaclesSyncKit only calls `silentSetCurrentValue` when the entity is ready at the time of `addStorageProperty`. Once ready, iterates the 5×5 window centred on `(centerX, centerY)`, returns `(vec2 | null)[]` in row-major order (index = `(dy+2)*5 + (dx+2)`). For each in-bounds cell: calls `getCellProperty` (creating a subscription if new), checks `localCellState` first, then reads `prop.currentValue`. Out-of-bounds cells are `null`. **At the end of the ready path it records the window** (`miniMapCenterX/Y = centerX/centerY`) and clears `miniMapDirty` — set at the end so any `onAnyChange` that fired while subscribing new cells is already captured in the returned snapshot. The not-ready path leaves the center as `NaN`, so `shouldRedrawMiniMap` keeps returning true (retrying) until the grid is ready.

**`shouldRedrawMiniMap(cx, cy)` / `isWithinMiniMapWindow(x, y)`**: the event-driven minimap pair. `shouldRedrawMiniMap` (public, called by `LocationTracker` every tick) returns true if the window is uninitialized (`NaN` center), the center cell changed, or `miniMapDirty` is set. `isWithinMiniMapWindow` (private) is the `|Δ| <= 2` membership test used by the two dirty-setters — the `onAnyChange` listener (remote updates) and `updateCellValue` (local writes) — so only changes to cells actually on-screen mark the map dirty.

> **Critical**: always use `prop.currentValue`, not `prop.currentOrPendingValue`, when reading lazily-subscribed properties. `SyncEntity.addStorageProperty` reads an existing store key via `silentSetCurrentValue`, which sets `currentValue` and `pendingValue` but deliberately skips `currentOrPendingValue`. So `currentOrPendingValue` stays at the constructor default (`vec2.zero()`) for any cell that existed in the cloud before the local client subscribed. `currentValue` is set correctly by both `silentSetCurrentValue` (initial load) and `applyRemoteValue` (all ongoing remote updates).

**`getCellDataReadOnly(x, y)`**: read helper that does NOT call `getCellProperty` — it only reads from `localCellState` and the existing `gridCells` Map via `prop.currentValue`. Useful when you need a value without side-effecting the subscription set. Not used by `getMiniMapCells`.

**`onAnyChange` listener**: Fires whenever the cloud reports any value change for a cell. Always clears the `localCellState` entry unconditionally — cloud is authoritative. The previous conditional clear (only when local cache matched cloud value) left stale cache entries when another player overwrote a pending local write: the mismatch meant the cache was never cleared, and `getMiniMapCells` continued reading the stale local value even though `prop.currentValue` was correct. `getMiniMapCells` also enforces a 5-second TTL on `localCellState` reads as a safety net. It also **marks the minimap dirty** (`miniMapDirty = true`) when the changed cell is within the current window (`isWithinMiniMapWindow`), so a remote player's stake/claim inside the view triggers a redraw without the local player moving.

#### Grid constants

```
height = 40           // grid is 40×40 cells
gridRadius = 20       // cells 0–39; center is between cells 19 and 20
unitsPerCell = 200    // 200 cm = 2 meters per cell
lastIdx = 1600        // 40 * 40
```

#### Coordinate conversion (Networker)

`gridPosToWorldCoords(col, row)`:
```
signedCol = col - gridRadius  →  world X = signedCol * unitsPerCell
signedRow = row - gridRadius  →  world Z = signedRow * unitsPerCell
```
Returns a `vec2(x, z)`. Used when spawning visuals (y is passed through from real-world device height).

---

### `PlayerVisuals.ts` — AR rendering and HUD

**All spawning** goes through `networkedInstantiator.instantiate()` from SpectaclesSyncKit's `Instantiator`, so every spawned object appears on all connected clients automatically. Transform data is passed via `InstantiationOptions` (`localPosition`, `localScale`) so the Instantiator writes `_init_pos` / `_init_scale` into the store before broadcasting — remote clients read those keys and spawn at the correct position and scale.

#### World visual spawning

**Claim cubes** (`createWorldClaimVolume(ID, x, y, z, scale)`):
- Position: `vec3(x, y - scale/6, z)` — the `scale/6` drop moves cubes from head height to body height
- Scale: `vec3(scale, scale, scale)` where `scale = unitsPerCell = 200`
- Prefab selected by `getClaimVolumeFromPlayerID(ID)` switch over 1–5
- Reference kept in `spawnedClaims: SceneObject[]`

**Stake cubes + pillars** (`createWorldStakeVolume(ID, x, y, z, scale)`):
- Spawns **two** objects per cell: a cube (same scale as claim) and a pillar
- Pillar scale: `vec3(1, scale, 1)` — full cell height, 1 unit wide
- Both references pushed into `spawnedStakes: SceneObject[]`
- Prefabs: `getStakeVolumeFromPlayerID(ID)` and `getStakePillarFromPlayerID(ID)`

**Destruction — self**: `DestroyAllClaims()` and `DestroyAllStakes()` iterate their arrays, call `obj.destroy()` on each, then reset array length to 0. These arrays only contain objects spawned by this local device (populated via `onSuccess`, which fires only on the spawner), so they are the correct path for self-death teardown only.

**Destruction — remote player** (`destroyPlayerVisuals(clientID, getPlayerVisualID)`): Used when a remote player dies or leaves. Resolves the dead player's visual ID, then iterates the Instantiator's `spawnedInstances` — this map is populated on every client for both local and remote spawns, so it covers all objects regardless of who created them. Finds all entries whose `dataStore.getString("_prefab_name")` starts with `"P" + visualID` (e.g., `"P2ClaimCube"`, `"P2StakeCube"`, `"P2StakePillar"`) and destroys them. Called by `Networker.handlePlayerDeath` in the remote-player path. To keep `spawnedInstances` from accumulating destroyed holders (the SDK never prunes it), two prunes run: `destroyPlayerVisuals` wraps the `getString` read in try/catch (skipping already-deleted stores) and deletes each matched or obviously-stale entry after destroying it; and every locally-spawned object registers a `networkRoot.onDestroyed` callback (`pruneOnDestroy`) that deletes its own entry when destroyed — which also covers the self-death teardown (`DestroyAllClaims/Stakes`), where `destroyPlayerVisuals` is never called.

> **SDK-internals access (TD-3)**: reaching `spawnedInstances` is *irreducible* — the Instantiator has no public enumerator and fires no callback for remote spawns, and PapAR's objects are spawned unowned (identity lives only in the `_prefab_name` prefix). All access is funnelled through **one** private helper trio: `getSpawnedInstances()` (the sole `(networkedInstantiator as any).spawnedInstances` cast; warns loudly and returns `null` if the field vanishes), `forEachSpawnedInstance(cb)`, and `deleteSpawnedInstance(id)`. The iteration/deletion helpers tolerate **both** the current SDK representation (a `Map` object whose entries are stored as plain-object properties → enumerate with `for..in`) and a hypothetical future real-`Map` (`.forEach()`/`.delete()`, used only when `for..in` finds nothing). Do **not** switch on `instanceof Map`: the current map *is* a `Map` instance yet holds entries as own properties, so `.forEach()` visits zero of them. See `KNOWN_ISSUES.md` TD-3.

#### 5×5 minimap

The minimap shows a ±2 cell window around the player on a pre-wired `Image[]` array (`miniMapCells`). The array is row-major: index = `miniMapY * 5 + miniMapX` where X and Y each run 0–4 (player is at 2,2).

**Active path — `updateMiniMapNetworked(cells, getPlayerVisualID)`**: Called by `LocationTracker` **only on a redraw** (gated by `Networker.shouldRedrawMiniMap`), not every tick. `cells` is the `(vec2|null)[]` returned by `Networker.getMiniMapCells()`. Each cell is colored by `getCellColorFromData()`, then written to `img.mainPass.baseColor` **only if the color changed** since the last write (cached per-`Image` in `img.__lastColor`, compared component-wise) — so redrawing all 25 when a single windowed cell changed skips the 24 unchanged GPU material writes. Cell coloring:
- `null` (out of bounds) → light gray `(0.75, 0.75, 0.75, 1.0)`
- `stakedBy != 0` → `getPlayerStakeColor(getPlayerVisualID(stakedBy))`
- `claimedBy != 0` → `getPlayerClaimColor(getPlayerVisualID(claimedBy))`
- unclaimed → white `(1, 1, 1, 0.2)`

Player colors by visual ID (1–5):

| visualID | Claim color | Stake color | Stake RGB (0–255) |
|---|---|---|---|
| 1 | green `(0, 1, 0, 0.425)` | yellow `(1, 1, 0.498, 0.425)` | `255, 255, 127` |
| 2 | blue `(0, 0.333, 1, 0.425)` | orange `(1, 0.666, 0, 0.425)` | `255, 170, 0` |
| 3 | dark red `(0.667, 0, 0, 0.425)` | magenta `(1, 0.333, 1, 0.425)` | `255, 85, 255` |
| 4 | purple `(0.667, 0, 1, 0.425)` | lavender `(0.667, 0.667, 1, 0.425)` | `170, 170, 255` |
| 5 | olive `(0.333, 0.266, 0, 0.425)` | olive `(0.666, 0.666, 0, 0.425)` | `170, 170, 0` |

Claim RGB values (0–255): P1 `0,255,0` · P2 `0,85,255` · P3 `170,0,0` · P4 `170,0,255` · P5 `85,68,0`

Stake cube and pillar materials share the same RGB. Pillars are fully opaque (alpha `1.0`); stake cubes are semi-transparent (alpha `0.117647` ≈ 30/255). The minimap uses a fixed alpha of `0.425` for all stake and claim colors regardless of the material alpha.

Material cloning: each `Image` in `miniMapCells` gets its material cloned on the first write (guarded by `img.__hasUniqueMaterial`) to prevent shared-material color bleed across all cells. This runs once per cell, on the first call.

**Legacy path — `updateMiniMap(gridPos, grid)`**: Reads from a local `SparseGrid` — not the cloud. This path is dead code; `GridClaimer.updatePos()` (its only caller) has been commented out. Do not call it. Use `updateMiniMapNetworked` instead.

#### Direction arrow

`onUpdate()` reads `deviceTracker.getDeviceTrackerRotation()` every frame. If the yaw actually changed since the last frame, `rotatePlayerArrow(yawRads)` applies `quat.fromEulerAngles(0, 0, yawRads)` to the arrow's 3D `Transform` (via `playerArrow.getTransform().setLocalRotation()` — note `playerArrow` is typed `ScreenTransform`, but `getTransform()` returns the underlying 3D Transform, which is what gets rotated). The "changed since last frame" guard is memoized in `previousRotation`, which `onUpdate()` updates after each rotate — so a perfectly still head skips the quaternion rebuild. Because `getDeviceTrackerRotation()` returns a continuous `atan2` value, the arrow still updates on nearly every frame while the head is turning.

#### HUD text

`updateHUDText(lat, long, gridx, gridy, latOff, longOff)` — despite the parameter names, the caller passes `(gridPos.x, gridPos.y, worldPosition.x, worldPosition.z, 0, 0)`. Displayed as grid coordinates and world position in AR overlay. The parameter naming is a legacy artifact from when GPS coordinates were used.

#### Respawn countdown display

A dedicated screen-space `Text` (`respawnCountdownText` `@input`, kept separate from `uiText` so the debug HUD and the timer don't fight over one component). Hidden on `onAwake()` via `hideRespawnCountdown()`; shown only during the respawn countdown, driven by `LocationTracker.handleRespawnCountdown()`.
- `showRespawnCountdown(seconds, blocked, outOfBounds = false)`: enables the Text's `SceneObject` and sets its text. When `blocked` (timer frozen) it shows `"You died!\nReturn to the play area"` if `outOfBounds`, else `"You died!\nMove to open ground"` (on claimed/staked territory); otherwise `"You died!\nRespawning in <seconds>"`.
- `hideRespawnCountdown()`: clears the text and disables the `SceneObject`.

Both methods no-op safely if the input is unassigned. Requires a centered screen-space `Text` object wired into `respawnCountdownText` in the Lens Studio scene.

#### `@input` fields (all assigned in Lens Studio scene)

`uiText`, `respawnCountdownText`, `screenTransform`, `cellMaterial`, `whiteCell`, `playerArrow`, `deviceTracker`, `networkedInstantiator`, `miniMapCells`, and 15 prefab references: `p1–p5 claimCellObj / stakeCellObj / stakePillarObj`.

---

### `GridClaimer.ts` — Legacy (being phased out)

**Do not add new game logic here.** `Networker.ts` has superseded all functionality from `GridClaimer`. However, `GridClaimer.ts` still provides two actively imported exports:

#### `SparseGrid` class

Local-only (not networked) sparse grid for single-player state or for `updateMiniMap`.

Storage:
- `claimedCells: Map<GridCell, { claimOwner: PlayerID }>` — key is `"x,y"` template literal type
- `stakedCells: Map<GridCell, PlayerID>` — separate map; staked cells take priority over claimed in `getCellState()`

Key methods:
- `getCellState(x, y)`: checks `stakedCells` first, then `claimedCells`, then returns `UNCLAIMED`
- `claimCell(x, y, player)`: writes to `claimedCells` AND deletes from `stakedCells`
- `stakeCell(x, y, player)`: writes only to `stakedCells`, leaves claim intact
- `getPlayerStakes(playerID)` / `getPlayerClaims(playerID)`: linear scan over maps, returns `GridCell[]`
- `unclaimCell`, `unstakeCell`: delete from respective map

`GridCell` is a TypeScript template literal type: `` `${number},${number}` ``. This enforces key format at compile time.

#### `CellState` enum

```typescript
export enum CellState {
    UNCLAIMED = "Unclaimed",
    CLAIMED = "Claimed",
    STAKED = "Staked",
}
```

Imported by `PlayerVisuals.ts` for minimap rendering.

The `GridClaimer` component class itself still has `updatePos()`, `handlePlayerDeath()`, `addStakedRegionToClaim()`, and `findAndFillEnclosedRegion()` — these are the local single-player equivalents of the networked versions in `Networker`. `LocationTracker` previously called `GridClaimer.updatePos()` but that call is now commented out.

---

### `UnionFindLoopDetection.ts` — Defunct stub

The `LoopDetection` class exists but its entire implementation is commented out. It was intended to detect loop closure using Union-Find (path compression + union by size), with a helper to convert a stake list to an adjacency list for 4-connected neighbors. This approach was abandoned in favor of the flood-fill in `Networker.findAndFillEnclosedRegion()`.

---

## Coordinate Systems

Three spaces exist simultaneously. Two functions convert between them:

### AR World → Grid

`worldCoordsToGridPos(wPos: vec2): vec2` (in both `LocationTracker` and `GridClaimer`):
```
cellX = worldX / 200
cellY = worldZ / 200
col   = floor(cellX + 20.5)   // +20 centers, +0.5 snaps to cell center
row   = floor(cellY + 20.5)
```
Result: integer grid indices `[0, 39]`. The origin cell (grid position 20, 20) maps to world coordinates (0, 0).

### Grid → AR World

`gridPosToWorldCoords(col, row): vec2` (in both `Networker` and `GridClaimer`):
```
worldX = (col - 20) * 200
worldZ = (row - 20) * 200
```
Returns the **center** of the cell in world XZ. The Y coordinate is never transformed — it always comes from the live device position.

### Visual spawn Y adjustment

When spawning cubes, `y` is adjusted: `spawnY = deviceY - (unitsPerCell / 6)` = `deviceY - 33.3cm`. This accounts for the device being at head level (~eye height) and drops cubes to approximately waist/body level for better AR framing.

---

## Prefab & Material System

### 15 prefabs (5 players × 3 types)

Located in `Assets/GrantWork/Volumes/`:

| Type | Prefab | Material | Shader |
|---|---|---|---|
| Claim cube | `P{n}ClaimCube.prefab` | `P{n}ClaimTransparentMat.mat` | `P{n}claim.ss_graph` |
| Stake cube | `P{n}StakeCube.prefab` | `P{n}StakeTransparentMat.mat` | `P{n}stake.ss_graph` |
| Stake pillar | `P{n}StakePillar.prefab` | `P{n}StakePillarMat.mat` | `P{n}pillar.ss_graph` |

### Shader types

**Claim shaders** (`P{n}claim.ss_graph`): Full PBR pipeline. Inputs: `baseTex` (Texture2D parameter, `ScriptName = "baseTex"`), `normalTex` (Normal Map parameter), `materialParamsTex` (Texture2D for metallic/roughness/AO), `uvScale` (Float parameter for UV tiling). The texture is sampled with UV scaled by `uvScale`, alpha is swizzled out from the texture sample for opacity. Final output is a PBR BRDF node with albedo, opacity, normal, metallic, roughness, and AO.

**Stake shaders** (`P{n}stake.ss_graph`): Simpler. A single `Custom Color` color value node feeds directly into `FinalColor` of the 3D Shader node. No texture sampling.

**Pillar shaders** (`P{n}pillar.ss_graph`): Identical structure to stake shaders — flat `Custom Color` → `FinalColor`. Minimal node graph.

All shaders use `SystemID = dev.snap.shaders`, Lens Studio's built-in shader graph system. The `.ss_graph` files are binary (not human-readable text) and must be edited in Lens Studio's Shader Graph editor.

### Editing material colors directly

`.mat` files are human-readable YAML. The active color for stake and pillar materials lives in the `Properties` section under `Port_Value_N000` (or `Port_Value_N008` for P1 stake/pillar which use a different shader variant). Format:

```yaml
Properties:
  Port_Value_N000:
    typeIdx: 5
    value: {x: R, y: G, z: B, w: A}
```

`CachedProperties` entries in the same file are stale shader compiler outputs and are not the live color — always edit `Properties`, not `CachedProperties`. When changing a material color, update the corresponding minimap color in `PlayerVisuals.getPlayerStakeColor()` or `getPlayerClaimColor()` to keep them in sync.

---

## Player Identity & Color Cycling

### Player ID (clientID)

Generated in `LocationTracker.getDeterministicPlayerId(displayName)` using FNV-1a:
```typescript
hash = 0x811c9dc5  // FNV offset basis
for each char: hash ^= charCode; hash += (hash<<1) + (hash<<4) + (hash<<7) + (hash<<8) + (hash<<24)
return (hash >>> 0) % 0xFFFFFF  // clamp to 16,777,215
```
`0xFFFFFF` cap ensures the ID fits in a float32 without precision loss (SpectaclesSyncKit stores `vec2` as float32). This means two different display names can theoretically produce the same clientID (collision probability low but non-zero).

### Visual color set (playerID)

`playerID` (1–5) is assigned by `Networker.assignAndWritePlayerID()` after the SyncEntity is ready and `clientID` is known. The assignment is stable for the cloud session **unless the player dies or leaves**: `handlePlayerDeath` zeroes the dead player's color slot on all remaining clients. On **respawn**, `respawn()` calls `assignAndWritePlayerID()` again, which — because the empty-slot search is seeded from `clientID % 5` — usually re-claims the same slot and keeps the player's color (it only changes if another player took the slot during the dead window). A player who fully **leaves** and rejoins later is treated as new and gets a fresh slot. A new player claims the first empty slot. Up to 5 unique colors are supported; a 6th concurrent player takes a **local-only** shared fallback color `(clientID % 5) || 5` **without** writing (or overwriting) any cloud slot — so it never corrupts an active player's color, at the cost of sharing a color with an active player (accepted tradeoff). `playerID` drives both prefab selection for 3D volumes and minimap color lookup — the two are always consistent.

---

## Networking Architecture (SpectaclesSyncKit)

### SyncEntity

One `SyncEntity` (`gridSyncEntity`) is created on the `Networker` component. All `StorageProperty` instances are added to this entity. The entity manages cloud store access (`canIModifyStore()`, `currentStore`) and event routing.

### Storage properties

`StorageProperty.manualVec2(key, defaultValue)` creates a named, typed cloud property. Adding it to the sync entity registers it for cloud synchronization. Once added, the property is never removed — it persists for the session.

**Maximum theoretical cells**: 40×40 = 1,600. In practice only visited cells get properties.

#### Reading lazily-subscribed properties: `currentValue` vs `currentOrPendingValue`

This is a non-obvious SpectaclesSyncKit gotcha that burned us on the minimap.

When `addStorageProperty` is called and the key already exists in the cloud store (another player wrote it earlier), SpectaclesSyncKit calls `storageProperty.silentSetCurrentValue(existingValue)` internally. That method sets `currentValue` and `pendingValue` — but **not** `currentOrPendingValue`. `currentOrPendingValue` stays at the default value from the property constructor (`vec2.zero()` in our case).

| Field | Set by `silentSetCurrentValue`? | Set by `applyRemoteValue` (future updates)? | Set by `setPendingValue` (local writes)? |
|---|---|---|---|
| `currentValue` | ✓ | ✓ | ✗ |
| `pendingValue` | ✓ | ✓ | ✓ |
| `currentOrPendingValue` | **✗** | ✓ | ✓ |

**Rule**: use `prop.currentValue` when reading a property that may have been lazily subscribed after the cloud already had a value for it. `currentOrPendingValue` is only reliable for properties that were subscribed before any remote writes, or for reads after at least one remote update has arrived post-subscription.

### Write strategy

`updateCellValue()` selects write mode based on:
- `description.includes("CONVERSION") || description.includes("INTERIOR")` AND `canIModifyStore()` → `setValueImmediate()` (synchronous write to cloud store)
- Otherwise → `setPendingValue()` (asynchronous; queued for next sync)

The local cache write always accompanies the cloud write, ensuring `getData()` returns the new value immediately without waiting for cloud confirmation.

### Event (RPC) system

`sendEvent(eventName, data)` broadcasts to all peers via the SyncEntity. `onEventReceived.add(eventName, callback)` registers a listener. Death events use this system (`"playerDeathEvent"`, `vec2(deadPlayerID, killerID)`) because they need to fire immediately and don't need persistent storage.

### Race condition prevention

`isPerformingBulkConversion` acts as a binary mutex: `sendData()` returns early while it's true, preventing the player from staking or triggering a second conversion while one is in progress. The 40ms/50ms `DelayedCallbackEvent` chains give SpectaclesSyncKit time to flush each property to cloud before the next write begins.

---

## Data Flow Diagram

```
Device position (AR world, cm)   [every 0.1s tick]
        │
        ▼ worldCoordsToGridPos()
Grid coordinates (0–39 int)
        │
        ├─▶ PlayerVisuals.updateHUDText()                    [every tick]
        │
        ├─▶ if Networker.shouldRedrawMiniMap():              [redraw only on window shift OR windowed cell change]
        │       Networker.getMiniMapCells()                  (records window, clears miniMapDirty)
        │       └─▶ PlayerVisuals.updateMiniMapNetworked()   (writes baseColor only for changed cells)
        │               reads prop.currentValue for all 25 cells in 5×5 window
        │               colors by player visual ID via Networker.getPlayerVisualID()
        │
        ├─▶ if DEAD: LocationTracker.handleRespawnCountdown()  [every tick while dead]
        │       reads Networker.getCellDataReadOnly() — on claimed/staked cell, reset to 3.0s
        │       on 0: Networker.respawn() + sendData()  (fresh home claim at current cell)
        │       else: PlayerVisuals.showRespawnCountdown()
        │
        └─▶ if ALIVE:
                ├─▶ Networker.getData()                     [every tick, debug logging only]
                │         (result not used for game logic)
                └─▶ if new cell: Networker.sendData()        [on cell change only]
                    │
                    │ (internal read of localCellState / currentValue)
                    │
                    ▼ sendData() decision tree
               ┌────┴─────────────────────────────┐
               │                                  │
          stake cell                     return to own claim
               │                                  │
               ▼                                  ▼
    updateCellValue(claimed, self)   addStakedRegionToClaim()
    stakeList.push(gridPos)              │
    createWorldStakeVolume()             ├─ convertStakesSequentially()
                                         │      updateCellValue() × N (40ms each)
                                         │      createWorldClaimVolume() × N
                                         │
                                         └─ findAndFillEnclosedRegion()
                                                claimInteriorCellsSequentially()
                                                updateCellValue() × M (50ms each)
                                                createWorldClaimVolume() × M
```

---

## Key Constants Reference

| Constant | Value | Location | Meaning |
|---|---|---|---|
| `unitsPerCell` | `200` | `Networker`, `LocationTracker`, `GridClaimer` | Cell size in cm (2 m) |
| `gridRadius` | `20` | `Networker`, `LocationTracker`, `GridClaimer` | Half of grid width |
| `height` | `40` | `Networker` | Grid width and height in cells |
| `localCacheMaxAge` | `5000ms` | `Networker.getData()` | Cache TTL before fallback to cloud |
| Conversion delay | `40ms` | `convertStakesSequentially()` | Delay between stake→claim writes |
| Interior delay | `50ms` | `claimInteriorCellsSequentially()` | Delay between interior cell claims |
| Position poll rate | `0.10s` | `LocationTracker` | How often player position is checked |
| Respawn countdown | `3.0s` | `LocationTracker` (`respawnDuration`) | Countdown before a dead player respawns |
| Respawn tick | `0.10s` | `LocationTracker` (`respawnTick`) | Countdown decrement per position tick (matches poll rate) |
| `MAX_SAFE_FLOAT32_INT` | `0xFFFFFF` | `LocationTracker` | Max clientID to avoid float32 precision loss |
| Death event name | `'playerDeathEvent'` | `Networker` | RPC event name for broadcast kills |

---

## Scene configuration reference (current state)

**`networkedInstantiator` (on `PlayerVisuals` scene object)**:
- `prefabs[]`: all 15 game prefabs registered ✓
- `spawnerOwnsObject: false` ✓
- `spawnAsChildren: true` ✓
- `spawnUnderParent` → `ColocatedWorld [CONFIGURE_ME]` ✓
- `autoInstantiate: false` ✓
- `persistenceString: Session` ✓

**`RespawnCountdownText` (screen-space `Text`, wired into `PlayerVisuals.respawnCountdownText`)**:
- Centered in the AR view, large readable font ✓
- Starts hidden — toggled at runtime by `PlayerVisuals.show/hideRespawnCountdown()` ✓
- Separate object from the `uiText` debug HUD ✓

**`SessionController [CONFIGURE_ME]` scene object**:
- `connectedLensModule` ✓
- `locationCloudStorageModule` ✓
- `isColocated: true` ✓
- `locatedAtComponent` → `ColocatedWorld [CONFIGURE_ME]`'s LocatedAtComponent ✓
- `skipUiInStudio: false` — multiplayer join UI shows in Studio preview; set to `true` to skip it during iteration

**`ColocatedWorld [CONFIGURE_ME]` scene object**:
- Has `LocatedAtComponent` directly on it ✓

The scene still contains leftover example objects from the SpectaclesSyncKit template that are not used: `SessionControllerExampleTypescript`, two `SessionControllerExampleJavascript` objects, `InstantiatorExampleAuto`, a `SyncTransform` demo object, and a `SyncMaterial` demo object (disabled). These can be deleted.

---

## Known Incomplete Areas

> **See [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md)** for the status-tracked defect & tech-debt
> register (severity, status, file+symbol, impact, fix hints). The prose below is the
> narrative source for the open items; the register is the checklist. Keep the two in sync.
> Fixed items are pruned from both docs to reduce bloat — git history preserves resolved detail.

### Game mechanics

- **Out-of-bounds death**: Walking outside the 40×40 arena kills the local player. The alive branch of `LocationTracker`'s position loop checks `Networker.isInBounds(gridPos)` and calls `Networker.killLocalPlayer()` when off-grid; the respawn countdown then treats out-of-bounds as `blocked` (same as standing on territory) so the player must return in-bounds onto open ground before respawning. The grid write/read paths themselves still don't validate bounds — the gate lives in `LocationTracker`.
- **Respawn edge cases**: Respawn is implemented (`Networker.respawn()` + `LocationTracker.handleRespawnCountdown()` — a 3-second countdown that resets whenever the player stands on any claimed/staked cell **or is outside the arena**, then places a fresh home claim). A few edges remain: (1) if an enemy claims the respawn cell in the 0.1s between the last countdown check and respawn, the forced home claim silently overwrites it; (2) the respawning player's color can change if another player claimed their freed slot during the dead window. (Stale `spawnedInstances` references from pre-death visuals are pruned via each holder's `onDestroyed` — see the `PlayerVisuals` destruction section / `KNOWN_ISSUES.md` TD-3.)
- **Multiplayer kill by territory**: `sendData()` only kills the owner of a **stake trail**. Entering an enemy's **claimed** cell does not kill the entering player (the `else`-branch just stakes over the enemy claim). To implement: in the `else`-branch, check `if (claimedBy !== 0 && claimedBy !== ID)` and fire a `playerDeathEvent` for the entering player.
- **Self-collision death is undocumented (KNOWN_ISSUES NET-9)**: `sendData`'s `if (stakedBy != 0)` branch fires the death RPC *before* the `stakedBy !== clientID` guard, so stepping back onto a cell you staked earlier this life kills you (`vec2(clientID, clientID)`). This is Paper.io-correct self-collision but isn't documented as an intended mechanic, and its payload (`killerID === deadPlayerID`) is indistinguishable from a voluntary-leave / out-of-bounds death — so a future kill feed can't tell them apart. Confirm intended and document, or move the `sendEvent` inside the self-guard.
- **Initial-spawn home claim is ungated (KNOWN_ISSUES NET-10)**: the `firstClaim` branch writes `vec2(ID, 0)` unconditionally without reading the cell. Respawn is protected by the "open ground" countdown, but the first join is not: starting co-located on an enemy's claimed/staked cell silently erases their claim and ignores their stake. Apply the same open-cell check the respawn path uses.

### Networking

- **Death cloud cleanup is best-effort**: `handlePlayerDeath` (Phase 3) only zeroes cells present in the running device's `gridCells` map (cells that have been `getCellProperty`'d). Cells the dead player visited but no remaining client has subscribed to remain stale in the cloud indefinitely. They cause no visual impact on other players' minimaps until someone walks within ±2 cells, at which point `getMiniMapCells` subscribes and reads the stale claim. There is no active purge mechanism.
- **clientID 0 collides with "unclaimed"**: `getDeterministicPlayerId` returns `0` if `displayName` is null. `computeClientID` in `Networker` guards against this (skips cleanup if result is 0), but a player who actually joins with a null display name would have their claims treated as unclaimed cells in `sendData()`'s decision tree, causing them to perpetually re-stake their own territory instead of triggering loop closure.
- **Simultaneous death-cleanup writes**: When multiple remaining clients all handle a death event (via RPC or `onUserLeftSession`), each independently writes the same per-component clear (zeroing only the dead player's own claim/stake, preserving any other player's value in the cell) to the same cloud cells. These writes are idempotent but produce redundant cloud traffic proportional to `(remaining players) × (dead player's subscribed cells)`.
- **Player count cap (partial)**: `assignAndWritePlayerID` supports up to 5 unique colors. A 6th concurrent, non-rejoining player finds no free slot and takes a **shared fallback color** (`playerID = (clientID % 5) || 5`) **without writing to the cloud slot table** — so an active player's slot is never corrupted (former defect NET-7). The residual tradeoff (documented, accepted): the 6th player shares a color with an active player on the minimap, and because `destroyPlayerVisuals` matches by the `"P{visualID}"` prefix, that 6th player's death can also destroy the co-colored player's cubes on remote clients. There is still no hard cap enforcing ≤5; a full cap + spectator/queue was deferred.

### Code quality

- **`getData()` ID parameter used only for logging**: `getData(ID, xpos, zpos)` references `ID` only in log statements (an opening trace and a "still staked by ID" warning), never for game logic. It's a legacy artifact; removing it means dropping those log lines too (see KNOWN_ISSUES TD-1).
- **`UnionFindLoopDetection.ts`**: Entirely commented out. The `LoopDetection` class compiles as an empty component. The Union-Find approach was abandoned in favor of the flood-fill in `Networker.findAndFillEnclosedRegion()`.
- **`computeClientID` duplicated**: The FNV-1a hash exists in both `LocationTracker.getDeterministicPlayerId` and `Networker.computeClientID`. If the hash algorithm ever changes, both must be updated. Could be extracted to a shared utility module.
- **Gated logging still builds the string every call (KNOWN_ISSUES TD-9)**: `log()` checks `showLogs` *inside* the method, so every `this.log("…" + a + …)` concatenates its argument before the call even when logging is off. In the 10 Hz loop this is real per-tick allocation on device — worst in `getData()` (~10 concatenations/tick), `sendData()`, and the `onAnyChange` cell listener. Guard hot call sites with `if (this.showLogs)`, or delete the per-tick `getData()` call (also TD-1).
- **Unbounded `gridCells` subscription growth (KNOWN_ISSUES TD-10 — churn fixed, ceiling remains)**: the minimap is now event-driven (`shouldRedrawMiniMap` gate), so `getMiniMapCells`/`getCellProperty` runs only on a redraw, not every tick — new cells are subscribed at most once per cell-*entry*. But each new cell still permanently adds a `StorageProperty` + cloud subscription + `onAnyChange` listener that is never removed, so a long traversal still accretes toward the 1600-cell ceiling (just far more slowly). Distinct from the best-effort cloud-cleanup item above (that's about stale *values*; this is about local subscription/listener cost).

### Stretch features

- **Sub-cell position indicator on minimap**: The minimap jumps when the player crosses a cell boundary rather than moving smoothly. A fractional position indicator would require computing `fracX = ((worldX % unitsPerCell) + unitsPerCell) % unitsPerCell / unitsPerCell` and `fracZ` similarly, then translating a `ScreenTransform` UI element within the bounds of the center minimap cell. Needs a new `Image` scene object wired into `PlayerVisuals`, updated every 0.1s tick.
- **Score / leaderboard**: No tracking of how many cells each player owns. Could be derived by iterating all subscribed `gridCells` and counting `currentValue.x === clientID`, but this is O(n) per tick and only covers subscribed cells. A dedicated `StorageProperty<number>` per player tracking claim count would be more efficient.
- **Kill feed / death announcement**: Death events are logged to `print()` only. A UI overlay showing who killed whom would use the `killerID` field already present in `playerDeathEvent`'s `vec2(deadPlayerID, killerID)` payload — `killerID === deadPlayerID` means the player left voluntarily.

---

## Lens Publication — Known Submission Blockers

A submission to Snap's Lens Explorer was rejected with the generic "Invalid Lens Submitted / violates our Guidelines" boilerplate. The likely causes, in priority order, against the [Spectacles publishing requirements](https://developers.snap.com/spectacles/get-started/start-building/publishing-lens) and [Lens Submission Guidelines](https://developers.snap.com/lens-studio/publishing/submitting/submission-guidelines):

1. **Trademark / IP** — the lens name `PapAR` and the "Paper.io-inspired" framing trade on Paper.io, a trademarked game by Voodoo. IP issues almost always trigger the generic boilerplate rejection rather than specific feedback. **Fix**: rename the lens to something non-derivative (e.g. "Territory AR", "Claim Trails") and scrub references to Paper.io from the lens name, description, release notes, and any in-game text.
2. **Encouragement of real-world risky behavior** — the core loop has players physically racing across an ~80m × 80m area in AR glasses. Snap explicitly bans content that encourages risky real-life behavior. **Fix**: add an onboarding screen warning players to play in a safe, open area clear of obstacles and traffic, and consider shrinking the play area.
3. **Missing required submission metadata** — eligibility requires all of: custom icon, 3×4 preview image, concise description, release notes, reviewer test notes, version number displayed at launch, and on-activation visuals communicating the objective. None of these are currently wired into the scene.
4. **Quality / stability flags for solo reviewers** — the multiplayer-only experience feels empty when tested solo. (Two former stability blockers are resolved: permadeath — players now respawn after a 3-second countdown, so a reviewer who dies early is no longer stuck; and the "conversion continues after death" glitch — conversion/interior chains now abort immediately on death via `conversionEpoch`, so a dead player no longer spawns stray claim visuals.)
