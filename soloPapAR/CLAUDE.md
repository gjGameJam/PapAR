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

**Lifecycle**: `onAwake()` registers a single callback, `SessionController.notifyOnReady()`, which sets `clientID` (from FNV-1a hash of display name), calls `Networker.setPlayerID(clientID)`, and then starts the position loop by calling `getDeviceTrackerPosition()`.

`clientID` is therefore always set before the first tick. The loop can start before the grid entity is ready; its own `gridReady` guards cover that window. (The loop still carries a `this.clientID == null` early-return ahead of the stake/claim/respawn branch. It dates from when the loop was started by a separate networked-Instantiator ready callback that could fire first; with the single callback it can no longer trigger.)

**Position loop**: A `DelayedCallbackEvent` that self-resets every **0.1 seconds**, continuously calling itself via `getNewPosition.reset(0.10)`. On each tick it:
1. Reads `playerTracker.getTransform().getWorldPosition()` (AR world space, cm)
2. Converts to grid coords via `worldCoordsToGridPos()`
3. Calls `PlayerVisuals.updateHUDText()` every tick
4. **Event-driven minimap redraw**: calls `Networker.shouldRedrawMiniMap(gridPos.x, gridPos.y)` (a cheap guard) and only when it returns true does it call `Networker.getMiniMapCells()` → `PlayerVisuals.updateMiniMapNetworked()`. A redraw fires only when the player crosses into a new cell (the 5×5 window shifts) or a cell **inside the current window** changed value (`Networker.miniMapDirty`, set by `updateCellValue` on local writes, by the cell `onAnyChange` listener on remote cloud updates, and by any color-slot change — which can recolor cells already on screen). While the player stands still and nothing in-window changes, the minimap does no per-tick read or recolor.
4b. **Event-driven leaderboard redraw**: when `Networker.shouldRedrawLeaderboard()` is true, calls `PlayerVisuals.updateLeaderboard(Networker.getLeaderboard(), clientID, getDisplayVisualID)`. Sits above the `clientID`/alive gates so it keeps updating while dead; costs one boolean read per tick when nothing changed.
5. **Branches on alive/dead state** (this branch only runs once `Networker.gridReady` is true):
   - **Dead** (`!Networker.isAlive`): calls `handleRespawnCountdown(gridPos, worldPosition)` — the respawn path (see below). The normal `getData`/`sendData` flow is skipped entirely while dead.
   - **Alive**: first checks bounds — if the grid position is outside the 40×40 arena (`!Networker.isInBounds()`), calls `Networker.killLocalPlayer()` (leaving the play area is fatal) and skips the rest of the tick. Otherwise calls `Networker.getData(clientID, gridPos.x, gridPos.y)` — result is used only for debug logging (`this.log("cell: " + gridPos + ...)`), not for game logic — then only calls `Networker.sendData()` if the player has moved to a **new cell** (checked by `PlayerVisuals.isInSameCell()`).

Step 3 (HUD) runs **every** tick regardless of alive/dead. Step 4 (minimap) runs every tick but is gated by `shouldRedrawMiniMap`, so it only *redraws* on an actual change — a dead player still sees the live map because a windowed cell change (or their own movement toward open ground) still triggers a redraw. This minimap block must stay **above** the alive/dead branch: `handleRespawnCountdown` reads the current cell via `getCellDataReadOnly` (which does not subscribe), and `getMiniMapCells` is what keeps the player's cell subscribed whenever the window center changes. The `gridReady` guard must wrap the `isInSameCell` call — `isInSameCell` has the side effect of updating `prevGridPos` on every false return, so calling it before `gridReady` would permanently consume the player's starting cell entry without placing a home claim.

Note: `sendData()` performs its own independent read of the cell state — it does **not** use the return value from the `getData()` call above.

**Respawn countdown** (`handleRespawnCountdown(gridPos, worldPosition)`): Runs once per 0.1s tick while the local player is dead. State lives in three private fields on `LocationTracker`: `respawnCountdown` (seconds remaining; `-1` = inactive), `respawnDuration` (= the shared `RESPAWN_FLOOR_S = 3.0` exported by `Networker` — see the TTL invariant under Ghost interceptors), and `respawnTick = 0.10` (must match the loop interval). Each tick:
1. Computes `blocked = !Networker.isLegalSpawnCell(gridPos.x, gridPos.y)` — the **one shared spawn-legality rule** (in-bounds AND fully open: no claim, no stake, by anyone; a side-effect-free read that registers no subscription). The same predicate gates `sendData`'s `firstClaim` write, so the countdown and the actual claim can never disagree. `outOfBounds = !Networker.isInBounds(...)` is computed separately only to pick the display message.
2. If the countdown is inactive (`< 0`) **or** `blocked` — standing on a claimed/staked cell **or** outside the arena — resets `respawnCountdown` to the full `respawnDuration`. This prevents respawning in an OP position (inside enemy territory / on a live stake) **and** prevents respawning off-grid: off-grid cells read as open (`vec2.zero()`), which is why bounds are part of the legality rule. Otherwise decrements by `respawnTick`.
3. When `respawnCountdown <= 0`: resets it to `-1`, calls `PlayerVisuals.hideRespawnCountdown()`, calls `Networker.respawn()`, then syncs `prevGridPos` via `PlayerVisuals.isInSameCell(gridPos)` and calls `Networker.sendData()` directly. Because `respawn()` re-armed `firstClaim`, this immediate `sendData()` places a fresh home claim at the current cell — exactly the same code path as the initial spawn, including the `firstClaim` branch's own write-instant `isLegalSpawnCell` re-check (if the cell somehow became occupied, the claim defers to the next open cell entered instead of overwriting). Syncing `prevGridPos` first means the next normal tick won't re-fire `sendData()` unless the player actually moves.
4. Otherwise calls `PlayerVisuals.showRespawnCountdown(Math.ceil(respawnCountdown), blocked, outOfBounds)` to update the on-screen timer.

Because the countdown starts at 3.0s and decrements by `respawnTick` (0.1s) each tick, the display holds "3", "2", "1" for ~1s each (~3s total). While the timer is frozen the display switches to "Move to open ground" (on claimed/staked territory) or "Return to the play area" (outside the arena).

**Player ID assignment**: On `SessionController.notifyOnReady()`, the local Snapchat display name is hashed via `getDeterministicPlayerId()` (FNV-1a) to produce `clientID`, then `Networker.setPlayerID(clientID)` is called (single argument). The visual color index `playerID` is **not** derived from a user count — it's assigned separately by `Networker.assignAndWritePlayerID()` via color-slot scanning once the grid is ready.

**Per-frame helpers** (both called from `PlayerVisuals.onUpdate()` every frame, independent of the 0.1s tick): `getDeviceTrackerRotation()` extracts yaw from the device quaternion using the standard formula and normalizes to `[0, 2π]`. `getMiniMapArrowOffset()` returns the player's sub-cell offset from the minimap window's center-cell center, in cell units — continuous grid coordinates (the `worldCoordsToGridPos` formula without the `floor`) minus `Networker.getMiniMapWindowCenter()`; before the first minimap draw it falls back to `floor()` of the player's own position, and the result is clamped to ±2.5 per axis so the arrow can never leave the 5×5 map frame. Drives the arrow's smooth slide (see PlayerVisuals "Direction arrow").

**Key `@input` fields**: `playerTracker: DeviceTracking`, `Networker`, `PlayerVisuals`

---

### `Networker.ts` — All game state and logic

This is the authoritative game logic script. It owns the entire cloud grid, manages the Paper.io rule set, drives stake/claim conversion, and handles death.

#### Initialization sequence

`onAwake()` first enforces the TTL invariant (TD-14): if `RECENTLY_DEAD_TTL_MS >= RESPAWN_FLOOR_S * 1000` it prints an unconditional `CONFIG ERROR` (not gated by `showLogs`) and clamps the TTL to 1 s under the floor — a TTL at/above the respawn floor would let the ghost interceptors eat every respawned home claim. It then creates `gridSyncEntity = new SyncEntity(this)`. When the entity is ready (`notifyOnReady`), `gridReady = true`, `seedPresentClients()` populates the presence cache from `getUsers()` (users whose join predates our handlers), and `initializeGridCells()` is called, followed by `seedClaimCounts()` (the one-time full-store scan that seeds the leaderboard tally **and draws every cube already in the session** — see Leaderboard tally and PlayerVisuals "World cubes") and then `replayPendingDeathCleanups()` (see Death handling — join-window queue). `initializeGridCells()` registers the five `playerColorSlot_*` StorageProperties (for player color mapping), attaches a **ghost-slot interceptor** to each (an `onAnyChange` that zeroes any incoming slot claim whose owner is recently-dead/departed and not present — closes the "slot claimed by a player who left within RTT" color leak; the same listener marks the leaderboard and minimap dirty, records the color in `lastVisualIDByClient`, and calls `refreshAllCubes()` so cubes follow a color change), and flushes any pending color write if `setPlayerID()` was called before the grid was ready. All grid cell properties are still created lazily on first access.

Three additional listeners are registered in `onAwake()` unconditionally (before `gridReady` — the RPC message channel subscribes at construction, so death events CAN arrive before the grid entity is ready):
- **Death RPC listener** (`playerDeathEvent`): fires on ALL clients whenever any player dies. Payload is `vec3(deadPlayerID, killerID, victimVisualID)`. Drops `deadPlayerID === 0` (the "unclaimed" sentinel — see Death handling), otherwise calls `handlePlayerDeath(deadPlayerID, victimVisualID)` — no client-ID guard. If `!gridReady`, the death is *also* queued in `pendingDeathCleanups` for a bounded replay at ready time.
- **`SessionController.onUserLeftSession`**: fires on all remaining clients when a peer disconnects. Hashes `userInfo.displayName` via `computeClientID()` (same FNV-1a as `LocationTracker`) to recover the leaving player's `clientID` (skips hash 0), removes the ID from the presence cache (so `isClientPresent` reads them absent throughout the cleanup), adds it to `departedClients`, queues a replay entry if `!gridReady`, calls `handlePlayerDeath(leftClientID, hint)` directly (no RPC needed — the event fires locally on each remaining device; the handler still resolves a visual-ID `hint` first, but nothing consumes it any more — see Death handling), runs the **full-store leave sweep** (`sweepStoreForDepartedClient` — clears the leaver's cells from the whole cloud store, including never-subscribed regions; see Death handling), and schedules **leave-only re-sweeps** at +2 s and +8 s (a store re-sweep, skipped at fire time if the player is present again) to catch cell writes whose network round-trip spanned the cleanup.
- **`SessionController.onUserJoinedSession`**: adds the joiner's clientID to the presence cache (`presentClientIDs`), deletes their `recentlyDead` entry (a rejoiner's ghost window must not outlive their return — without this, a leave+rejoin inside the 2 s TTL would still get their fresh home claim ghost-cleared; former defect NET-16), and removes them from `departedClients` — a rejoining player's new writes and slot claim must not be treated as ghosts, and queued leave-replays skip present players.

#### Player ID fields

- `clientID: number` — the FNV-1a hash of the Snapchat username (unique per player, persists across sessions)
- `playerID: number` — visual color set index `1–5`; assigned by `assignAndWritePlayerID()` and stable for the cloud session **unless the player dies, leaves, or respawns** (see Player color mapping below)

#### Player color mapping

Five `StorageProperty<vec2>` slots (`playerColorSlot_1` through `playerColorSlot_5`) are registered at grid-ready time. Each stores `vec2(clientID, playerID)`. `playerID` determines which slot is used (slot index = `playerID - 1`).

Assignment is handled by `assignAndWritePlayerID()`, called once `gridReady` is true and `clientID` is known (whichever happens last):
1. **Rejoin detection**: scan all 5 slots for a matching `clientID`. If found, reuse the stored `playerID` — no cloud write needed. This guarantees a returning player always gets their original color.
2. **New player**: scan for the first empty slot (`currentValue.x === 0`), starting from `clientID % 5` to reduce simultaneous-join collisions. Claim it with `setPendingValue(vec2(clientID, slotIdx+1))`.
3. **All slots full** (6+ players, none ours): take a **local-only** shared fallback color `(clientID % 5) || 5` and **do not write the cloud slot** — overwriting an occupied slot would corrupt that player's color mapping on every client. `getPlayerVisualID()` derives the same value for any player without a slot, so remote coloring stays consistent. Accepted tradeoff: this player shares a **color** with an active player. (Their death does not remove the co-colored player's cubes: cubes are drawn per cell from the cell's owner clientID and are never matched by color.)

**Slot freeing on death/leave**: `handlePlayerDeath` scans slots and writes `vec2.zero()` to the slot whose `currentValue.x` matches the dead player's clientID. This runs on all remaining clients simultaneously (idempotent). A player who fully **leaves** and rejoins later will no longer find their old slot and will be assigned a new one — intentional, since leaving is treated as permanent death. A **respawn** is different: `respawn()` immediately re-runs `assignAndWritePlayerID()`, which — because its empty-slot search is seeded from `clientID % 5` — usually re-claims the same slot (and therefore the same color) that death just freed. The color only changes if another player grabbed that slot during the dead window.

`getPlayerVisualID(clientID)` scans the five slots for a matching `clientID` and returns its `playerID` (1–5). Falls back to `(clientID % 5) || 5` if no slot has been written yet for that player. **Must use `currentValue`** (not `currentOrPendingValue`) when reading slots — `silentSetCurrentValue` only sets `currentValue`, so slots written by remote players before this client subscribed would read as `vec2.zero()` via `currentOrPendingValue`, causing incorrect color assignment. The local player's own `playerID` is returned directly from `this.playerID` via a fast-path check, bypassing the slot lookup entirely.

`getDisplayVisualID(clientID)` is the **display** variant, used by the minimap, the leaderboard and the world cubes (`drawCellCubes` picks the cube prefabs with it): identical while the player holds a slot, but when no slot names them it returns the color they last held (`lastVisualIDByClient`, fed by the slot `onAnyChange` and the seeded slot values) before falling back to the modulo. Every client frees a victim's slot the instant they die, before their cells have all cleared, so without this their remaining cells, cubes and leaderboard row flash the fallback color. A remembered color is dropped when a different client claims that color. Slot assignment and the death-event payload keep using `getPlayerVisualID`.

#### Cell data format

Each cell is stored as a `StorageProperty<vec2>`:
- `.x` = `claimedByID` (0 = unclaimed)
- `.y` = `stakedByID` (0 = not staked)

A cell can simultaneously have a non-zero claim AND a non-zero stake (player staking over enemy territory). Keys follow the pattern `"cell_x_y"` (e.g. `"cell_22_18"`).

#### `sendData(ID, xpos, zpos, realWorldCoords)` — The main game loop

Called by `LocationTracker` each time the player enters a new cell. Guards: returns early if `!isAlive` or `isPerformingBulkConversion` or `!gridReady`.

Decision tree (in order):
1. **`firstClaim == true`**: First re-checks `isLegalSpawnCell(xpos, zpos)` — if the cell is occupied (claimed **or** staked, by anyone) or out of bounds, the home claim is **deferred**: `firstClaim` stays armed and `sendData` returns, so the claim lands on the first *open* cell the player enters instead of silently erasing a co-located player's territory (former defect NET-10; also the write-instant re-check for the respawn claim, former NET-8). Ghost values can't wedge the gate: a departed player's stale cell was healed at subscription (seed-check) before this read, and a still-connected kill victim's stragglers clear within ~1 RTT via their own sweep. Once legal: write `vec2(ID, 0)` as the home claim (the claim cube follows from the cell value — see below), set `firstClaim = false`, return early. Note that while the claim is deferred the rest of the tree never runs — a player without a home claim cannot stake or kill.
2. **Ghost-stake kill gate (F5)**: if `stakedBy != 0` but the stake's owner is **not in the session** (`!isClientPresent(stakedBy)` — a ghost trail, e.g. a leaver's pending write that outraced the death-clear), do **not** fire the death event (clientIDs are stable across lives, so killing a ghost ID could detonate the full cleanup machinery against a rejoined player's live session). Instead treat the stake as stale: normalize `stakedBy` to 0 and fall through the rest of the tree — the ghost self-heals (an explicit `"GHOST STAKE CLEAR"` write when falling into the conversion branch, which wouldn't otherwise rewrite the cell; the stake branch's own write covers the other cases). **Deliberate gameplay change**: a truly-departed player's ghost trail is claimable, not lethal. Present players are unaffected — including yourself (self-collision, see step 3) and dead-but-respawning victims (idempotent re-death).
3. **`stakedBy != 0`**: The cell has someone's stake in it. Compute `onOwnClaim = (claimedBy === clientID)` and `stakerIsSelf = (stakedBy === clientID)`, then fire the `playerDeathEvent` RPC `vec3(stakedBy, clientID, getPlayerVisualID(stakedBy))` — killing whoever owns that stake — **except** on the degenerate self-claim+self-stake cell (`onOwnClaim && stakerIsSelf`), where firing would self-kill you on ground you own (such `(A,A)` cells only ever arose from the old re-stake path this branch replaced). Then sub-branch:
   - **`onOwnClaim`** — you stepped back onto your **own** claimed cell that a live enemy had staked. **Close the loop**: call `addStakedRegionToClaim()` (kill + convert), exactly like step 4, instead of re-staking. This cell is already yours and seals the loop, so it is **not** pushed to `stakeList` or rewritten — the killed enemy's death-clear zeroes their stake component back to `(clientID, 0)`. If there's no open trail, `addStakedRegionToClaim` no-ops (so it just kills the enemy). This fixes the former defect where killing an enemy whose stake sat inside your claim left your loop un-closed; it mirrors the ghost-stake path (step 2), which already healed `claimedBy == ID` and fell through to conversion.
   - **else if `stakedBy !== clientID`** — an enemy's stake on a cell you do **not** own. Also claim the cell for yourself: push to `stakeList`, update `localCellState`, and show the stake cube **immediately** (the cell is added to `deferredStakeKeys` and noted via `noteCell` — see below), but **defer the cloud write 500 ms** so it lands *after* the killed player's death-clear (otherwise their clear would erase it). That deferred write captures `conversionEpoch` and **no-ops if the epoch changed** — i.e. if you looped back to your own claim (a conversion) or died within the 500 ms — so it can't revert a just-converted claim back to a stake, nor write a stake for a dead player (fixes former defect D3).
   - **else** (`stakerIsSelf` on a cell you don't own — your own **trail**): the death event above already self-killed you — **intended Paper.io self-collision**, a documented mechanic; no re-stake. Self-collision now only applies to your own *trail* (a cell you don't own), never to a stake sitting on your own *territory*. Caveat for a future kill feed (FEAT-3): the self-collision payload shape `killerID === deadPlayerID` is identical to the voluntary-leave and out-of-bounds shapes, so the three causes need a distinct flag before they can be labeled. The third payload component is the victim's visualID; it is still sent but no longer consumed, see Death handling.
4. **`claimedBy == ID`**: Player stepped onto their own claimed territory. Call `addStakedRegionToClaim()` to convert the pending trail. Reached only when the cell is **not** staked — a present enemy's stake on your own claim is handled by step 3 (which now closes the loop the same way, plus the kill).
5. **Else** (unclaimed or enemy-claimed): Push `vec2(xpos, zpos)` to `stakeList`, write `vec2(existingClaim, ID)` to cloud (immediately); the stake cube + pillar follow from the cell value.

`sendData` (and the conversion chains) never create or destroy a cube directly. Every cell write goes through `updateCellValue` → `noteCell`, which redraws that cell's cubes on this device (see Leaderboard tally and PlayerVisuals "World cubes"); every other client draws the same cubes when the cell value reaches it. The one case where a cube must show before any cell write exists is the deferred enemy-stake write (step 3). **`deferredStakeKeys`** holds those cell keys: while a key is in the set, `noteCell` reports the local player as that cell's staker whatever value arrives, and the cell's `onAnyChange` listener re-seeds `localCellState` with `(claim, clientID)` — so the cube and the minimap keep showing our stake while other values for the cell pass through (typically our own death-clear for the kill, run synchronously inside `sendEvent` and promoted at that frame's LateUpdate). The key is removed when the 500 ms timer fires (the real write, or its cancellation, takes over). `clearDeferredStakes()` empties the set on local death and at conversion start, re-noting each cell from what its property actually holds (`pendingValue || currentValue`).

The deferred enemy-stake write (step 3) **re-reads the claim owner when it fires** (freshest on-device value: the property's `pendingValue`, which every path sets — store seed, remote update, local write) and writes `vec2(liveClaim, ID)` — never the owner captured 500 ms earlier, who may have died or lost the cell in between.

#### Stake → claim conversion pipeline

`addStakedRegionToClaim()` → guarded by `isPerformingBulkConversion` (boolean mutex).

Steps:
1. Set `isPerformingBulkConversion = true`, **bump `conversionEpoch`**, and capture `const epoch = this.conversionEpoch`. (Bumping here also cancels any still-pending 500 ms enemy-stake write from this trail — every staked cell is in `stakeList` and thus in this batch, so those deferred writes must not fire.)
2. Call `clearDeferredStakes()` — any stake still shown ahead of its deferred write is in this batch. Stake cubes are **not** removed up front: each one disappears when its own cell converts (step 4)
3. Copy `stakeList` to `stakesToConvert`, then clear `stakeList`
4. Call `convertStakesSequentially(stakesToConvert, 0, realWorldCoords, epoch, onComplete)`
5. In `onComplete`: call `findAndFillEnclosedRegion(stakesToConvert, realWorldCoords, epoch)`, then set `isPerformingBulkConversion = false`

(`realWorldCoords` is still threaded through `sendData`, `addStakedRegionToClaim` and both chains, but nothing reads it any more — cube height comes from the local viewer at draw time, see PlayerVisuals "World cubes".)

`convertStakesSequentially(stakes, index, realWorldCoords, epoch, onComplete)` processes one stake per call. For each stake it:
- **Aborts (returns without calling `onComplete`) if `conversionEpoch !== epoch`** — a death or a newer batch superseded this chain; this stops it writing cells for a dead or superseded life (fixes former defect NET-3).
- Reads current cloud value, writes `vec2(clientID, 0)` (claim = self, stake = cleared)
- That write is what swaps the cell's stake cube + pillar for a claim cube, on every client (`noteCell`) — so the trail turns from stake cubes into claim cubes one cell at a time, at the chain's pace
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

**Two triggers** both route to `handlePlayerDeath(ID, visualIDHint?)` on every remaining client:

1. **In-game kill**: `sendData()` fires an RPC when a player steps on a *present* enemy's stake trail (see the kill gate in the decision tree):
   ```
   gridSyncEntity.sendEvent('playerDeathEvent', vec3(stakedBy, clientID, victimVisualID))
   ```
   All clients receive this and call `handlePlayerDeath(deadPlayerID, victimVisualID)` with no client-ID guard. The `z` component (the victim's color index) is still sent and still passed along as `visualIDHint`, but nothing reads it any more — it only served the networked-cube sweep that no longer exists. A `deadPlayerID` of 0 is dropped at the listener.

2. **Player leaves**: `SessionController.onUserLeftSession` fires on each remaining device. `computeClientID(userInfo.displayName)` re-derives the leaving player's clientID via the same FNV-1a hash used at join time; the handler records the ID in `departedClients`, then calls `handlePlayerDeath(leftClientID, hint)` directly (no RPC needed — the event fires independently on every remaining device), runs the **full-store leave sweep** (`sweepStoreForDepartedClient`, see below — clears the leaver's cells even in regions this client never subscribed), and schedules the +2 s/+8 s re-sweeps (a store re-sweep at each firing).

**Join-window queue (NET-15)**: deaths that arrive before `gridReady` still run `handlePlayerDeath` immediately (for a remote death only the recently-dead registration takes effect pre-ready; the cell sweep and slot-free are no-ops) *and* are queued in `pendingDeathCleanups`. `replayPendingDeathCleanups()` runs in `notifyOnReady` right after `initializeGridCells()` (slots are seeded synchronously at that point) with a bounded policy — staleness bounds are what keep a replay from destroying a respawned/rejoined player's NEW life, since clientIDs are stable across lives:
- entries with `id === clientID` are dropped (never run local teardown from a replay);
- **kill** entries older than `RECENTLY_DEAD_TTL_MS` are dropped (the victim stays connected and self-cleans; a stale replay is pure friendly-fire risk);
- **leave** entries replay at any age but are skipped when `isClientPresent(id)` (rejoined). A replay runs the slot-free (+ `departedClients` tracking) — explicitly **not** the Phase 3 cell sweep (`gridCells` is empty at that instant) — but leave entries **do** run the full-store sweep (`sweepStoreForDepartedClient` needs only `currentStore`, which is ready by replay time, not `gridCells`) and **re-anchor `scheduleLeaveResweeps`** from ready-time (the pair scheduled at leave-event time can both have fired pre-`gridReady` on a slow init, where their store sweeps guard out; re-scheduling is idempotent). The `getCellProperty` seed-check remains the second-line defense for anything the sweeps miss.

`handlePlayerDeath(ID, visualIDHint?)` — guard first: **returns immediately for `ID === 0`** (the "unclaimed" sentinel — a 0-ID sweep would component-match every lazily-subscribed cell and wipe the session's territory; the RPC listener and `killLocalPlayer` mirror the guard). Then it **registers the recently-dead window** (`registerRecentlyDead`, see the ghost interceptors below) and runs **three independently-guarded phases** — each wrapped in its own try/catch that logs the phase name, so a throw in one phase can never abort the rest. The code and its logs number them 1, 3 and 4; there is no Phase 2 and no visual phase of any kind — cubes are local and follow the cell values (see PlayerVisuals "World cubes"), so clearing a dead player's cells is what removes their cubes:

**Phase 1 — Local-only teardown** (`if ID === this.clientID`, method `deathPhaseLocalTeardown`):
- `isAlive = false`, `firstClaim = true`, `stakeList = []`
- **`conversionEpoch++`** and **`isPerformingBulkConversion = false`** — invalidates any in-flight conversion/interior chain and pending deferred stake write from this now-dead life (they self-abort on their next tick), and releases the mutex so it can't linger while dead.
- `localCellState.clear()`, `localCacheTimestamps.clear()`
- `clearDeferredStakes()` — drops any stake still shown ahead of its deferred write. The player's cubes need no other teardown: Phase 3 (next) clears their cells on this device and the cubes go with them.

**Phase 3 — Cloud cell sweep** (all clients, guarded by `gridReady`, method `deathPhaseCellSweep`): iterates `gridCells` — for any cell whose `currentValue` **or `currentOrPendingValue`** names the dead player in a nonzero component, only the **dead player's own component** is zeroed (a per-component clear, preserving another player's claim/stake in the same cell) via `updateCellValue(…, "DEATH CLEAR")`. Because each clear goes through `updateCellValue` → `noteCell`, the dead player's cubes at those cells are removed on this device in the same call. Matching `currentOrPendingValue` too is the NET-12 fix: the victim's freshest writes went through `setPendingValue`, which only `currentOrPendingValue` sees until the LateUpdate flush/server echo — matching `currentValue` alone let those writes flush to the cloud *after* death and go permanently stale (minimap ghosts + landmine stakes). The clear is *based on* `currentOrPendingValue` whenever it names the dead player **or has any nonzero component** (former defect NET-18): a nonzero `cop` was necessarily written post-subscription (`setPendingValue` and `applyRemoteValue` both set it), so it is always at least as fresh as `currentValue` on-device — this stops a same-frame mutual death from resurrecting the first victim's just-cleared component, *and* keeps the local player's own un-flushed pending write (e.g. a respawn home claim over a stale `cur` naming the dead player) from being dropped in the sub-frame window before the LateUpdate promotion. An **all-zero** `cop` may just be the `silentSetCurrentValue` seeding gotcha (see Reading lazily-subscribed properties) and falls back to `currentValue`. Each cell is processed in its own try/catch so one bad cell can't abandon the sweep. Still best-effort: only covers cells that have been `getCellProperty`'d on this device — see the ghost interceptors below and `KNOWN_ISSUES.md` NET-5 for the residual.

**Phase 4 — Color-slot free** (all clients, method `deathPhaseFreeColorSlot`, runs **unconditionally** — the slots array is empty before ready, so no guard is needed; a separate phase so a cell-sweep failure can't skip it): scans `playerColorSlots`, finds the slot whose `currentValue.x === ID`, writes `vec2.zero()` via `setPendingValue`. This makes the color available for the next joining player.

**Full-store leave sweep** (`sweepStoreForDepartedClient(leftClientID)` + `healStoreCellsChunked` — leave paths only, *not* part of `handlePlayerDeath`): closes NET-5's leave residual. Phase 3 can only clear cells this device has subscribed, and a client who joins *after* the leave never receives the leave event at all — so on a leave, every remaining client also enumerates `gridSyncEntity.currentStore.getAllKeys()` and per-component-clears every **unsubscribed** `cell_` key naming the leaver directly in the cloud store, healing the store itself for current and future clients. Guards: `leftClientID !== 0` (NET-2 sentinel), `gridReady`, `currentStore` + `canIModifyStore()`, `departedClients.has(id)`, `!isClientPresent(id)` — re-checked at every invocation *and* every heal chunk (a mid-sweep rejoiner's new claims must survive; same clientID). The collect pass is synchronous local reads; heals are written in chunks of `STORE_SWEEP_CHUNK` (40) per `STORE_SWEEP_CHUNK_DELAY_S` (0.05 s), each write re-reading and re-gating the live value. Three hard rules: (1) **subscribed keys (`gridCells`) are skipped** — SyncEntity drops self-echoes, so a raw `putVec2` on a key we hold a `StorageProperty` for would leave our own property permanently stale (those cells belong to Phase 3 + the `onAnyChange` interceptor); (2) **clears are `putVec2` writes, never `store.remove()`** — SyncEntity never wires `onStoreKeyRemoved`, so removals don't propagate to subscribed clients; (3) **leave-only, never kills** — clientIDs are stable across lives, so a late full-store sweep after a kill would erase the respawned victim's new claims (the `departedClients` guard makes this structural: kills never enter that set). Called from `onUserLeftSession` (right after `handlePlayerDeath`, so the subscribed/unsubscribed split is stable), from each `scheduleLeaveResweeps` firing, and from the leave branch of `replayPendingDeathCleanups`. NET-6-class redundancy accepted: every remaining client sweeps, but writes are read-gated + changed-only, so duplicates exist only within the RTT window.

`computeClientID(displayName: string): number` — private method on `Networker`, identical FNV-1a algorithm as `LocationTracker.getDeterministicPlayerId`. Used in the `onUserLeftSession`/`onUserJoinedSession` handlers and `isClientPresent()` to recover a clientID from a display name. Guards against null input (returns 0) — if the result is 0, cleanup is skipped since clientID 0 collides with the "unclaimed" sentinel.

`isClientPresent(id)` — public; true when a client with this ID is currently connected. **Set-backed** (former NET-17/TD-11): consults `presentClientIDs` first — a cache maintained by the join/leave handlers (which already compute the hash), seeded from `getUsers()` at grid-ready, and backfilled by the fallback scan — so presence queries don't re-hash every display name, and a cached player can't transiently read as absent just because `getUsers()` momentarily reports a blank `displayName` (which previously let the kill gate erase a live stake). On a cache miss it falls back to the display-name-hash scan of `getUsers()`, backfilling every hash it computes; no negative caching (an absent id must stay re-checkable). The local player is always present. Presence ≠ alive — a dead-but-connected (respawning) player IS present, which is exactly right for every caller: the `sendData` kill gate, the ghost predicate (`isGhostID`), the leave re-sweeps, and the replay policy.

Note: after death, `isAlive = false` prevents `sendData()` from doing anything until the player respawns (see below).

#### Ghost interceptors (recently-dead window + departed clients)

The Phase 3 sweep can only clear cells this device has subscribed, and cannot see writes that were still in flight *from other devices* at death time. Two tracking mechanisms close those gaps (NET-12's durable half), unified behind **one predicate**, `isGhostID(id, sentServerMs)` (former TD-13 — no open-coded variants): an id is a ghost when it is departed **or** recently-dead **and — in both cases — not present** (`!isClientPresent`). A **present client is never a ghost** (former NET-16): the presence requirement protects a fast-rejoining leaver's fresh writes and a kill victim's post-respawn slot re-claim, while a present-but-dead kill victim needs no interception anyway — their own device's Phase 3 sweep rewrites every cell they touched (all subscribed there), and those clears are sent *after* the stale writes, so last-wins storage converges without it. Absent authors — the ones who can't self-clean — are still cleared.

- **`recentlyDead` window**: `handlePlayerDeath` records `clientID → deadline` where deadline = server-time-at-receipt + `RECENTLY_DEAD_TTL_MS` (2 000 ms — **must stay under the `RESPAWN_FLOOR_S` respawn floor**, or the interceptor would eat the respawned player's fresh home claim; enforced by the `onAwake()` clamp, TD-14). A remote write is treated as inside the window if its `updateInfo.sentServerTimeMilliseconds` ≤ deadline; local echoes/seeded values use the current server time. **Arrival skew, not clock skew, is the hazard**: a ghost write *sent* before the window closed is cleared no matter how late it lands; a write *sent* after (the respawned home claim) survives no matter how fast it arrives. Falls back to `Date.now()` deltas when the session clock is unavailable. Entries are deleted on rejoin (`onUserJoinedSession`) so a returning player's window can't outlive their return; otherwise never removed (bounded by deaths per session).
- **`departedClients` set**: leave-ghosts are the durable ones — the leaver's device is gone and can't self-clean — so values naming a departed client are cleared with **no time window**. Added on leave (handler + replay), removed on rejoin (`onUserJoinedSession`).

Three consumers (all via `isGhostID`):
1. **Per-cell `onAnyChange` interceptor** (`interceptGhostCellWrite`): any arriving cell value (remote update or local-write echo) naming a ghost author gets an immediate per-component `"GHOST CLEAR"` write. Accepted NET-6-class cost: every client that sees the write issues the same clear (the SDK's `equalsCheck` suppresses identity writes; the window is bounded).
2. **`getCellProperty` seed-check**: values seeded by `addStorageProperty` (`silentSetCurrentValue`) fire **no events**, so a ghost value already sitting in the cloud store is only ever caught here, at first subscription. Since the full-store leave sweep (see Death handling) now heals the store itself at leave time, this is the **second-line** defense for leave-ghosts (races and sweep gaps) rather than the primary heal; it remains the only catch-point for seeded kill-ghost values.
3. **Ghost-slot interceptor** (`interceptGhostSlotWrite`, attached in `initializeGridCells`): zeroes any incoming color-slot claim from a ghost author — closes the session-long color leak when a player's slot claim outraces everyone's slot-free (left within RTT). The predicate's presence check protects a kill victim's post-respawn re-claim.

**Self-ghost clause** (in `interceptGhostCellWrite`): `isGhostID` never matches the local player (always present), so while the local player is **dead** its own device additionally clears any arriving value that names it and was sent inside its own recently-dead window (`id === clientID && !isAlive && isRecentlyDead`). This catches another client's read-modify-write that re-asserts the victim's old claim after the victim's sweep ran. A dead player writes nothing naming itself, and `!isAlive` is required (a duplicate death event re-opens the window, which could otherwise overlap the respawn home claim).

#### Respawn

`respawn()` (public, called by `LocationTracker.handleRespawnCountdown` once the countdown completes) re-enables a dead **local** player. `handlePlayerDeath`'s local-only phase already reset `firstClaim = true`, cleared `stakeList`, and cleared the local caches (the player's cubes went with their cells in the Phase 3 sweep) — so `respawn()` only needs to:
1. Return early if `!gridReady`.
2. Set `isAlive = true`.
3. Re-assert `firstClaim = true` and `stakeList = []` (defensive; already set on death).
4. Clear `isPerformingBulkConversion = false` — in case the player died mid-conversion, this stops a stale mutex from wedging future stakes.
5. Call `assignAndWritePlayerID()` to re-claim a color slot and reset `this.playerID`. This is required because `handlePlayerDeath` (Phase 4) freed the dead player's color slot on **all** clients; without re-claiming, remote clients would color the respawned player's new cells via the `(clientID % 5) || 5` fallback. The empty-slot search is seeded from `clientID % 5`, so the player almost always reclaims the same slot/color.

Respawn is entirely local — there is no cloud-side respawn state or RPC. The player's fresh home claim is **not** placed by `respawn()`; it is placed by the immediate `sendData()` call in `handleRespawnCountdown` (which hits the `firstClaim` branch now that `respawn()` re-armed it — including that branch's write-instant `isLegalSpawnCell` re-check). That home claim is *sent* ≥3 s after death, safely outside the 2 s recently-dead window, so no client's ghost interceptor clears it (see Ghost interceptors — this ordering is why `RECENTLY_DEAD_TTL_MS` must stay under `RESPAWN_FLOOR_S`, enforced by the `onAwake()` clamp).

#### Out-of-bounds death

`isInBounds(x, y): boolean` — public; true when `(x, y)` is a valid cell in `[0, height)` (the same predicate `getMiniMapCells` uses). The grid write/read paths (`sendData`, `getCellProperty`, `getCellDataReadOnly`) do **not** self-validate bounds, so callers must gate on this.

`killLocalPlayer()` — public; kills the **local** player when they leave the arena. Guards on `gridReady && isAlive` (and a nonzero `clientID` — the ID-0 sentinel guard), fires `playerDeathEvent` as `vec3(clientID, clientID, playerID)` with `onlySendRemote = true` (so remotes clear our cells and color slot — and with the cells, our cubes — without a local echo), then calls `handlePlayerDeath(this.clientID)` directly — mirroring the `onUserLeftSession` path. `LocationTracker.getDeviceTrackerPosition` calls this from the alive branch whenever `!isInBounds(gridPos)`; the dead branch's `handleRespawnCountdown` then blocks respawn until the player returns in-bounds onto open ground.

#### Cloud storage & local cache

**Lazy property creation** via `getCellProperty(x, y)`: checks `gridCells` Map first; if missing, creates `StorageProperty.manualVec2("cell_x_y", vec2.zero())`, adds it to `gridSyncEntity`, stores it in the map, attaches an `onAnyChange` listener, then runs the **ghost seed-check**: if the value seeded by `addStorageProperty` names a recently-dead/departed player, it is per-component-cleared immediately (seeded values fire no events, so this is the only place they can be caught — see Ghost interceptors).

**Subscribing must not write (`adoptDefaultIfAbsent`)**: a `StorageProperty` created with a default starts with `currentValue` null, so SyncKit's first LateUpdate flush would *send* the default `(0,0)` for any key not yet in the store — which can land after another client's first real write still in flight and erase it. `getCellProperty` and the color-slot loop therefore call `adoptDefaultIfAbsent(prop)` right after `addStorageProperty`: if `currentValue` is still null it calls `silentSetCurrentValue(vec2.zero())`, making current and pending equal so nothing is sent. Do not remove it, and apply it to any new lazily-created property. (Also saves ~5 writes per cell step.)

**`updateCellValue(x, y, newValue, description)`**: the single write path. Always:
1. Uses `setValueImmediate()` if description contains `"CONVERSION"` or `"INTERIOR"` and `canIModifyStore()` is true; otherwise uses `setPendingValue()`
2. Always writes to `localCellState` map with current timestamp
3. Marks the minimap dirty (`miniMapDirty = true`) if `(x, y)` is within the current window — so local stakes/claims/conversions/interior fills appear immediately, without waiting for the cloud round-trip.

**`getData(ID, x, y)`**: read path. The `ID` parameter is used **only for logging** (an opening trace and a "still staked by ID" warning) — never for game logic; it's a legacy artifact and could be removed along with those log lines. Checks `localCellState` first (uses if cache age < **5000ms**); falls back to `cellProp.currentValue`; returns `vec2.zero()` on any error. Note: `sendData()` does NOT call `getData()` — it reads cell state directly from `localCellState`/`currentValue` internally. `getData()` is called every tick by `LocationTracker` for debug logging only.

**`getMiniMapCells(centerX, centerY)`**: public minimap data provider. Returns early with 25 `vec2.zero()` values if `!gridReady` — this prevents `getCellProperty` (and thus `addStorageProperty`) from being called before the SyncEntity is ready, which would leave `currentValue` permanently at `vec2.zero()` since SpectaclesSyncKit only calls `silentSetCurrentValue` when the entity is ready at the time of `addStorageProperty`. Once ready, iterates the 5×5 window centred on `(centerX, centerY)`, returns `(vec2 | null)[]` in row-major order (index = `(dy+2)*5 + (dx+2)`). For each in-bounds cell: calls `getCellProperty` (creating a subscription if new), checks `localCellState` first, then reads `prop.currentValue`. Out-of-bounds cells are `null`. **At the end of the ready path it records the window** (`miniMapCenterX/Y = centerX/centerY`) and clears `miniMapDirty` — set at the end so any `onAnyChange` that fired while subscribing new cells is already captured in the returned snapshot. The not-ready path leaves the center as `NaN`, so `shouldRedrawMiniMap` keeps returning true (retrying) until the grid is ready.

**`shouldRedrawMiniMap(cx, cy)` / `isWithinMiniMapWindow(x, y)`**: the event-driven minimap pair. `shouldRedrawMiniMap` (public, called by `LocationTracker` every tick) returns true if the window is uninitialized (`NaN` center), the center cell changed, or `miniMapDirty` is set. `isWithinMiniMapWindow` (private) is the `|Δ| <= 2` membership test used by the two cell dirty-setters — the `onAnyChange` listener (remote updates) and `updateCellValue` (local writes) — so only changes to cells actually on-screen mark the map dirty. (A third setter, the color-slot `onAnyChange`, is not window-gated: a slot change is rare and can recolor any visible cell.)

**`getMiniMapWindowCenter()`**: public; returns the center cell of the last-*drawn* window as a `vec2`, or `null` before the first draw (`NaN` center). Consumed every frame by `LocationTracker.getMiniMapArrowOffset()` so the player arrow's sub-cell offset is measured against the window the map actually drew — the offset drops by exactly one cell in the same tick `getMiniMapCells` commits a new center, keeping the sliding arrow glued to the map content across cell-boundary crossings.

> **Critical**: always use `prop.currentValue`, not `prop.currentOrPendingValue`, when reading lazily-subscribed properties. `SyncEntity.addStorageProperty` reads an existing store key via `silentSetCurrentValue`, which sets `currentValue` and `pendingValue` but deliberately skips `currentOrPendingValue`. So `currentOrPendingValue` stays at the constructor default (`vec2.zero()`) for any cell that existed in the cloud before the local client subscribed. `currentValue` is set correctly by both `silentSetCurrentValue` (initial load) and `applyRemoteValue` (all ongoing remote updates).

**`getCellDataReadOnly(x, y)`**: read helper that does NOT call `getCellProperty` — it only reads from `localCellState` and the existing `gridCells` Map via `prop.currentValue`. Useful when you need a value without side-effecting the subscription set. Not used by `getMiniMapCells`.

**`onAnyChange` listener**: Fires whenever the cloud reports any value change for a cell (and, at the LateUpdate flush, for local pending-write promotions — with a `null` `updateInfo`). Always clears the `localCellState` entry unconditionally — cloud is authoritative. The previous conditional clear (only when local cache matched cloud value) left stale cache entries when another player overwrote a pending local write: the mismatch meant the cache was never cleared, and `getMiniMapCells` continued reading the stale local value even though `prop.currentValue` was correct. `getMiniMapCells` also enforces a 5-second TTL on `localCellState` reads as a safety net. It also **marks the minimap dirty** (`miniMapDirty = true`) when the changed cell is within the current window (`isWithinMiniMapWindow`), so a remote player's stake/claim inside the view triggers a redraw without the local player moving. It then passes the new claim and stake owner to `noteCell` (leaderboard tally + world cubes); while the cell is in `deferredStakeKeys` it first re-seeds `localCellState` with our own stake (see `sendData`). Finally it runs the **ghost interceptor** (`interceptGhostCellWrite`, see Ghost interceptors) on the new value.

#### Leaderboard tally (score = claimed cells × `SCORE_PER_CELL`)

Scores are **derived from the cell store on each client** — there is no cloud score counter (a counter would drift: a player's claim count is changed by many writers — enemy captures, death clears from every client, leave sweeps, ghost clears). The tally is **event-driven, never polled**, and the same per-cell feed draws the world cubes:

- State: `claimOwnerByKey: Map<cellKey, clientID>` and `stakeOwnerByKey: Map<cellKey, clientID>` (nonzero owners only), `claimCounts: Map<clientID, cells>`, `leaderboardDirty`. The stake map exists for the world cubes; stakes never score.
- **`noteCell(key, claimOwner, stakeOwner)`** is the single per-cell funnel: the only place the tally changes **and** the only place the world cubes are driven from. It diffs both owners against the last known ones for that cell and returns at once if neither changed, so it is idempotent — hearing about one change twice is harmless. A claim-owner change updates `claimCounts` and sets `leaderboardDirty`. **Any** change (claim or stake) queues the debounced recount and calls `drawCellCubes(key)` → `PlayerVisuals.setCellCubes(key, claimVisualID, stakeVisualID, x, z, unitsPerCell)`, with the two owners' colors from `getDisplayVisualID` (0 = none) and the cell center from `gridPosToWorldCoords`. `drawCellCubes` is wrapped in try/catch: display code must never break the tally or a store callback. A cell in `deferredStakeKeys` always reports the local player as its staker (see `sendData`).
- Sources feeding it (each passes the claim owner **and** the stake owner): (1) `seedClaimCounts()` — a one-time `recountClaimsFromStore()` (full `currentStore.getAllKeys()` scan) in `notifyOnReady` (seeded values fire no events) — this is also where a late joiner draws every cube already in the session; (2) `gridSyncEntity.storeCallbacks.onStoreUpdated` — fires for **every** key in the grid store, subscribed or not (see Networking Architecture), covering remote changes anywhere on the grid without adding `gridCells` subscriptions; (3) `updateCellValue` — our own writes, counted and drawn optimistically (the platform may not echo them back); (4) `healStoreCellsChunked` — the raw leave-sweep `putVec2`; (5) the per-cell `onAnyChange` listener — the confirmed value wins for subscribed cells, correcting (3) when a remote write and our pending write cross; (6) the deferred-stake pair in `sendData` / `clearDeferredStakes()` — shows, then withdraws, a stake that has no cell write yet.
- `leaderboardDirty` is also set by the join/leave handlers (presence filters the board), the color-slot `onAnyChange` (a slot change recolors rows — it also calls `refreshAllCubes()`, which re-runs `drawCellCubes` for every tracked cell; `setCellCubes` rebuilds only the cells whose color index actually changed), and `setPlayerID` (the board can only mark the local row once `clientID` is known).
- **`shouldRedrawLeaderboard()`** (public) returns the dirty flag; **`getLeaderboard()`** (public) returns `{clientID, score}[]` for every **present** player with ≥1 claimed cell, sorted by score desc then `clientID` asc (identical order on all clients), and clears the flag. Absent ids are filtered so a departed player's not-yet-swept cells never show a ghost row. Stakes never score.
- **Presence retry**: if a scoring id reads absent but is not in `departedClients` (a pre-existing player's display name can be blank right after we join, and no join event fires for them), `getLeaderboard()` leaves the flag set so the next tick looks again — bounded by `LEADERBOARD_PRESENCE_RETRIES` (30 ticks) so a hard-crashed peer can't cause a redraw every tick forever.
- **One key rule**: `isTallyCellKey(key)` (well-formed, in-bounds `cell_x_y`) is shared by the seed/recount and the store listener; the two property-side call sites gate on `isInBounds(x, y)`. Never count a key under a different rule in one path — a client present for a write and a late joiner must count the same keys.
- **Debounced recount (safety net)**: every `noteCell` change — claim **or stake** — queues, if none is queued, one `recountClaimsFromStore()` `LEADERBOARD_RECOUNT_DELAY_S` (3 s) later — a full re-read of the store replica (≤1600 local reads) that re-notes every key, zeros included, and drops tracked keys (claim or stake) the store no longer holds. Because it goes through `noteCell`, it reconciles the cubes as well as the scores. It runs only while cells are changing (at most once per 3 s) and never while the grid is idle, so it is not a poll. It exists because the event stream is not sufficient on its own: when two clients write one cell with different owners inside a round trip, the last event a client sees is not necessarily the value the store ended on (and `SyncEntity` drops a property's own echo). Residual, unverified: if the platform does not echo a client's own write **and** its local replica keeps the losing value, that one cell stays miscounted on that client until its next write — the same last-writer divergence the cell's `StorageProperty` and the minimap already have. A two-device test logging `updateInfo.updaterInfo.connectionId` in the store listener would settle it.
- The leaderboard call in `LocationTracker`'s tick and the setup calls in `PlayerVisuals.onAwake()` are wrapped in try/catch (unconditional `print` on failure): display code sits ahead of the `reset()` that keeps the game loop alive and must never be able to stop it.

- **Own-echo diagnostic**: with `showLogs` on, the store listener prints `OWN STORE ECHO #n` whenever an update's `updaterInfo.connectionId` is the local connection. Seeing the line proves delivery only; to settle the residual above, have two devices write one cell at the same moment and compare `store.getVec2(key)` on both afterwards.

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
Returns a `vec2(x, z)` — the cell center in the colocated space. Used by `drawCellCubes` to place a cell's cubes (their y is chosen by `PlayerVisuals.cubeHeight`).

---

### `PlayerVisuals.ts` — AR rendering and HUD

**World cubes are local, not networked.** Claim cubes, stake cubes and stake pillars are plain local `SceneObject`s that each client builds and destroys for itself from the synced cell grid; creating or removing a cube sends nothing over the network. `Networker.noteCell` calls `setCellCubes` whenever a cell's claim or stake owner changes (see Networker "Leaderboard tally"), so the cubes always mirror this client's view of the grid: a death or a leave needs no cube cleanup of its own (clearing the cells removes the cubes), and there is no asynchronous spawn that could finish after its owner died. Do not go back to networked cubes: they were once spawned through SyncKit's `Instantiator`, whose spawns completed only after a network round-trip — a life or batch that ended mid-flight orphaned cubes on every client, and removing another player's cubes required reaching into the Instantiator's private instance map.

The flip side of mirroring the grid: a cell value that is stale on this client shows as a stale cube until the cell is corrected (see the kill-ghost residual, `KNOWN_ISSUES.md` NET-5).

#### World cubes (`setCellCubes`)

`setCellCubes(key, claimVisualID, stakeVisualID, x, z, scale)` makes the cubes at one cell match its state. The IDs are color indices `1–5` (`0` = none); `(x, z)` is the cell center in the colocated space; `scale = unitsPerCell = 200`. State lives in `cellCubes: Map<cellKey, { claimID, claim, stakeID, stake, pillar }>` — one record per cell that currently shows something, holding the objects and the color indices they were built for. Only what changed is rebuilt, so calling it with unchanged values does nothing:

- **Claim cube** — rebuilt when `claimVisualID` differs from the record's `claimID`: the old cube is destroyed and, if the new ID is nonzero, a new one is spawned from `getClaimVolumeFromPlayerID(claimVisualID)` (switch over 1–5) at `vec3(x, cubeHeight(scale), z)` with scale `vec3(scale, scale, scale)`.
- **Stake cube + pillar** — rebuilt together when `stakeVisualID` differs from the record's `stakeID`: **two** objects per cell at the same position, a cube from `getStakeVolumeFromPlayerID(stakeVisualID)` (same scale as a claim cube) and a pillar from `getStakePillarFromPlayerID(stakeVisualID)` with scale `vec3(1, scale, 1)` — full cell height, 1 unit wide.
- The claim part and the stake part are independent, so a cell claimed by A and staked by B shows A's claim cube and B's stake cube + pillar at once.
- A record's `claimID`/`stakeID` is only set when the spawn returned an object, so a failed spawn is retried on the next call for that cell. The record is deleted once it shows neither a claim nor a stake.

**`spawnLocal(prefab, x, y, z, localScale)`** creates a holder `SceneObject` (`"cellCube"`) under the colocated root, sets the holder's **local** position and scale, then calls `prefab.instantiate(holder)` — the same holder-plus-prefab construction the Instantiator used, so the prefabs look as they did. It returns `null` (with a log) if the prefab or the parent is missing, and destroys the half-built holder if anything throws.

**`getCubeParent()`** resolves that root once and caches it: `SessionController.getInstance().getLocatedAtComponent().getSceneObject()` — the `ColocatedWorld` object. Positions are local to it and x/z come from the grid cell, so a cell's cubes sit at the same physical spot on every device. It is re-resolved if the cached object is null or destroyed.

**Cube height is taken from the local viewer.** `cubeHeight(scale)` reads `deviceTracker.playerTracker`'s world y at the moment the cube is drawn and subtracts `scale / 6` (the drop from head height to body height; it falls back to `0 - scale/6` if the read throws). Height is not synced and not stored: every client places every cube — its own and other players' — relative to *its own* device height at the time *it* drew that cube, so two viewers can see the same cube at different heights, and a cube keeps the height it was drawn at until it is rebuilt. Accepted for now; not yet tuned.

**A late joiner builds all existing cubes at once.** At grid-ready `seedClaimCounts()` re-notes every cell in the store in one synchronous pass, so every claim cube and stake cube + pillar already in the session is instantiated in that single call (up to 1600 cells). `refreshAllCubes()` can likewise rebuild all of one player's cubes in one call when their color index changes. Accepted for now; not yet tuned (no batching or pooling).

**`safeDestroy(obj)`** is the only destroy path: it skips null / `isNull()` natives and try/catches the `destroy()`, logging a failure rather than swallowing it.

**Legacy no-op stubs**: `createWorldClaimVolume`, `createWorldStakeVolume`, `DestroyAllClaims` and `DestroyAllStakes` remain only as empty methods so the unused `GridClaimer.ts` still compiles. They do nothing — do not call them; the live game draws cubes only through `setCellCubes`.

#### 5×5 minimap

The minimap shows a ±2 cell window around the player. Each of the 25 map positions has **two stacked Image layers** so a cell can convey claim and stake **at the same time**, distinguished by shape rather than by color alone:
- **Background square** — the pre-wired `Image[]` array (`miniMapCells`), always full-cell size. Shows **claim state only** (claim color / white / gray). Row-major: index = `miniMapY * 5 + miniMapX`, X and Y each 0–4 (player at 2,2).
- **Stake dot overlay** — the runtime-built `stakeDots: (Image|null)[]` array (index-aligned to `miniMapCells`), a small centered square (`stakeDotScale = 0.4` of the cell) shown **only when that cell is staked**, in the staker's color. Because it sits *on top of* the background, the claim/white background stays visible in the space around the dot.

**Active path — `updateMiniMapNetworked(cells, getPlayerVisualID)`**: Called by `LocationTracker` **only on a redraw** (gated by `Networker.shouldRedrawMiniMap`), not every tick. `cells` is the `(vec2|null)[]` returned by `Networker.getMiniMapCells()`. For each of the 25 positions it does two independent, separately-memoized writes:
- **Background**: color from `getCellBackgroundColor()`, written to `img.mainPass.baseColor` **only if changed** since the last write (cached per-`Image` in `img.__lastColor`, component-wise) — so redrawing all 25 when one windowed cell changed skips the unchanged GPU writes. Background reflects claim state only (stake is the dot overlay):
  - `null` (out of bounds) → light gray `(0.75, 0.75, 0.75, 1.0)`
  - `claimedBy != 0` → `getPlayerClaimColor(getPlayerVisualID(claimedBy))`
  - unclaimed → white `(1, 1, 1, 0.2)`
- **Stake dot**: `applyStakeDot(i, stakedBy != 0 ? getPlayerStakeColor(getPlayerVisualID(stakedBy)) : null)`. A non-null color **enables** the dot's `SceneObject` and tints it (memoized on the dot's own `__lastColor`); `null` **disables** it. So a cell claimed by A and staked by B shows A's claim color as the background with B's stake dot on top.

**Stake-dot construction & alignment (`positionStakeDot`, called from `alignMiniMapCells`)**: each dot is aligned **exactly like the claim cell** — same parent (`Full Frame Region`), same `parentST.worldPointToLocalPoint` world→anchor conversion, just inset to the centered `stakeDotScale` fraction of the cell's world rect — and copies the cell's render `layer` so the **same UI camera draws it** (a freshly created `SceneObject` starts on the default layer and would otherwise be invisible). Dots are created lazily (once) after the cells in hierarchy order, so they render **on top of** the background squares; each gets its own cloned `cellMaterial` + the `whiteCell` texture and starts disabled. Caveat: because dots are the last siblings under `Full Frame Region`, the center cell's dot can render over the `PlayerArrow` when the player stands on a staked cell.

Player colors by visual ID (1–5) — **claim color drives the background square; stake color drives the dot**:

| visualID | Claim color | Stake color | Stake RGB (0–255) |
|---|---|---|---|
| 1 | green `(0, 1, 0, 0.425)` | yellow `(1, 1, 0.498, 0.425)` | `255, 255, 127` |
| 2 | blue `(0, 0.333, 1, 0.425)` | orange `(1, 0.666, 0, 0.425)` | `255, 170, 0` |
| 3 | dark red `(0.667, 0, 0, 0.425)` | magenta `(1, 0.333, 1, 0.425)` | `255, 85, 255` |
| 4 | purple `(0.667, 0, 1, 0.425)` | lavender `(0.667, 0.667, 1, 0.425)` | `170, 170, 255` |
| 5 | olive `(0.333, 0.266, 0, 0.425)` | olive `(0.666, 0.666, 0, 0.425)` | `170, 170, 0` |

Claim RGB values (0–255): P1 `0,255,0` · P2 `0,85,255` · P3 `170,0,0` · P4 `170,0,255` · P5 `85,68,0`

Stake cube and pillar materials share the same RGB. Pillars are fully opaque (alpha `1.0`); stake cubes are semi-transparent (alpha `0.117647` ≈ 30/255). The minimap uses a fixed alpha of `0.425` for all stake and claim colors regardless of the material alpha.

Material cloning: each background `Image` in `miniMapCells` gets its material cloned on the first write (guarded by `img.__hasUniqueMaterial`) to prevent shared-material color bleed across all cells; each `stakeDots` Image is created with its own `cellMaterial.clone()` up front for the same reason.

**Legacy path — `updateMiniMap(gridPos, grid)`**: Reads from a local `SparseGrid` — not the cloud. This path is dead code; `GridClaimer.updatePos()` (its only caller) has been commented out. Do not call it. Use `updateMiniMapNetworked` instead.

#### Direction arrow (rotation + sub-cell slide)

`onUpdate()` reads `deviceTracker.getDeviceTrackerRotation()` every frame. If the yaw actually changed since the last frame, `rotatePlayerArrow(yawRads)` applies `quat.fromEulerAngles(0, 0, yawRads)` to the arrow's 3D `Transform` (via `playerArrow.getTransform().setLocalRotation()` — note `playerArrow` is typed `ScreenTransform`, but `getTransform()` returns the underlying 3D Transform, which is what gets rotated). The "changed since last frame" guard is memoized in `previousRotation`, which `onUpdate()` updates after each rotate — so a perfectly still head skips the quaternion rebuild. Because `getDeviceTrackerRotation()` returns a continuous `atan2` value, the arrow still updates on nearly every frame while the head is turning.

**Sub-cell slide**: `onUpdate()` also calls `deviceTracker.getMiniMapArrowOffset()` every frame — the player's offset from the minimap window's center-cell center, in cell units (normally within `[-0.5, 0.5)` per axis). When the offset changed since last frame (memoized in `previousArrowOffset`, exact component compare like `previousRotation`), `positionPlayerArrow(off)` rebuilds the arrow's ScreenTransform **anchors** around `map center + off × cell size` with **pure anchor-space arithmetic** (offsets stay zero), sizing the arrow at 60% of its authored size (`arrowScale = 0.6`, applied to the captured half-size). Grid +X maps to screen right, grid +Z to screen **down** (matching the cell layout). Anchors-only positioning composes cleanly with rotation: the layout derives the Transform's *position* from anchors but never its *rotation*. The needed geometry (`arrowGeom`: map-center position, cell size, and arrow half-size — **all pre-converted into the parent's normalized anchor space**) is captured once by `captureArrowGeometry()` at the end of `alignMiniMapCells()`, using the same `worldPointToLocalPoint` conversion (and the same instant) the cell anchors were just written with. Nothing world-space is kept: the world↔screen mapping can change after `onAwake` (render target / ortho camera initialization), so converting capture-time *world* coordinates per frame drifts the arrow off the map — capture-time-converted anchors instead share the cells' guarantee (a later rescale moves map and arrow together). The arrow's center is re-derived from the captured map center every frame, so at runtime it snaps exactly onto the map center even though its authored anchors sit slightly off. If capture fails (unassigned arrow, missing parent ST, misaligned minimap), `arrowGeom` stays `null` — the slide is disabled with a log and rotation keeps working. **Boundary continuity**: because the offset is measured from `Networker.getMiniMapWindowCenter()` (the last-*drawn* window) rather than `floor()` of the player's own position, the arrow slides marginally past the cell edge for ≤1 tick after a boundary crossing, then drops back one cell in the same instant the 25 tiles recolor — visually continuous against the map content (a floor-based fraction would flick the arrow a full cell up to ~100 ms before the content shifts).

#### HUD text

`updateHUDText(gridX, gridY, worldX, worldZ, spareA, spareB)` — the caller passes `(gridPos.x, gridPos.y, worldPosition.x, worldPosition.z, 0, 0)`. Displayed as grid coordinates and world position in AR overlay. The last pair is always `0, 0` and renders as the `N/A:` line. (The parameters were formerly named `lat/long/latOff/longOff`, a legacy artifact from an abandoned GPS-based design — renamed so nothing in the codebase implies geolocation; see the location-permission blocker under Lens Publication.)

#### Respawn countdown display

A dedicated screen-space `Text` (`respawnCountdownText` `@input`, kept separate from `uiText` so the debug HUD and the timer don't fight over one component). Hidden on `onAwake()` via `hideRespawnCountdown()`; shown only during the respawn countdown, driven by `LocationTracker.handleRespawnCountdown()`.
- `showRespawnCountdown(seconds, blocked, outOfBounds = false)`: enables the Text's `SceneObject` and sets its text. When `blocked` (timer frozen) it shows `"You died!\nReturn to the play area"` if `outOfBounds`, else `"You died!\nMove to open ground"` (on claimed/staked territory); otherwise `"You died!\nRespawning in <seconds>"`.
- `hideRespawnCountdown()`: clears the text and disables the `SceneObject`.

Both methods no-op safely if the input is unassigned. Requires a centered screen-space `Text` object wired into `respawnCountdownText` in the Lens Studio scene.

#### Leaderboard display

`updateLeaderboard(entries, localClientID, getPlayerVisualID)` — called by `LocationTracker` only on a leaderboard change. Uses the `leaderboardRows: Text[]` input (4 rows, top-left corner). Each row is a **player-color dot + the score in white** — no rank numbers, names, or labels; row order is the ranking. Rows 0–2 show the top three; rows without an entry are hidden. The **local player's row is marked by a white ring around its dot**. When the local player is outside the top three their own score (0 when they hold no cells) gets its own ringed row: the first free top row when fewer than three players are scoring, otherwise row 3. Only `LEADERBOARD_ROW_COUNT` (4) rows are ever driven; extra wired rows are hidden. `positionLeaderboardRows()` writes all anchors and is re-run on every redraw, rewriting only if the parent's world-per-anchor ratio changed since the last layout (the screen mapping can change after `onAwake`, which would otherwise leave the squares non-square). Text styling (white fill, background off, alignment) is applied even if `cellMaterial`/`whiteCell` are unassigned; only the squares are skipped. Runtime Images set `stretchMode = StretchMode.Stretch` explicitly because `whiteCell` is a 1920×1080 texture. `setLeaderboardRow(i, text, visualID, isLocal)` toggles the text/dot/ring objects and memoizes text and visualID on each `Text`, writing only what changed. No-ops if the input is unassigned; all rows are hidden in `onAwake()`.

**Dots and rings are built at runtime** (`layoutLeaderboard`, called once from `onAwake()` after `alignMiniMapCells()`), the same way as the minimap stake dots: siblings of the row `Text` under its parent, copying its render `layer`, each with a cloned `cellMaterial`. **The code owns the whole layout**, in the parent's anchor space (screen = −1…1), from private constants: `leaderboardTop` (0.92) / `leaderboardLeft` (−0.92) place the top-left corner, `leaderboardRowPitch` (0.13) is the row height, the dot's side is `leaderboardDotScale` (0.48) × the pitch, the ring is `leaderboardRingScale` (1.4) × the dot (created first so the dot draws on top), and row 3 sits `leaderboardOwnRowGap` (0.5) pitches lower. Anchor width is derived from anchor height via the parent's world-per-anchor ratio so the squares are square on screen. Each row's `Text` rect is **overwritten** too (right of the ring, same band, `leaderboardTextWidth` wide, vertically centered, left-aligned, Background forced off so no box hides the 3D visuals) — the rects authored in the editor do not matter (they were once full-screen, which pushed rect-derived squares off-screen; do not go back to deriving layout from them). The "dot" and "ring" are **squares** by design (they echo the grid cells): both use the minimap's `whiteCell` texture, the dot tinted via `baseColor` with the claim color at alpha 1 and the ring left white, so the ring reads as a white outline around the local player's square. No procedural texture or extra asset is involved. The rows share the top-left corner with the `uiText` debug HUD, so `showHUDText` should be off in normal play.

**Row squares use the claim color unchanged**: `setLeaderboardRow` tints the square with `getPlayerClaimColor(visualID)`'s RGB at alpha 1, so a row matches that player's territory. Do not brighten it — scaling the dark colors up was tried and rejected because P5 brown then read as orange. Tradeoff: the dark colors (P3 dark red, P5 brown) are dimmer on the additive Spectacles display.

#### `@input` fields (all assigned in Lens Studio scene)

`uiText`, `respawnCountdownText`, `leaderboardRows` (optional), `screenTransform`, `cellMaterial`, `whiteCell`, `playerArrow`, `deviceTracker`, `miniMapCells`, and 15 prefab references: `p1–p5 claimCellObj / stakeCellObj / stakePillarObj` (instantiated locally by `setCellCubes`). `deviceTracker` (the `LocationTracker`) also supplies the device height for `cubeHeight`.

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
Returns the **center** of the cell in world XZ. The Y coordinate is never transformed — it always comes from the live device position of whichever client is drawing the cube.

### Visual spawn Y adjustment

When a cube is drawn, `PlayerVisuals.cubeHeight` sets its `y`: `spawnY = deviceY - (unitsPerCell / 6)` = `deviceY - 33.3cm`, where `deviceY` is the **local viewer's** device height at that moment (not the cell owner's — height is not synced; see PlayerVisuals "World cubes"). This accounts for the device being at head level (~eye height) and drops cubes to approximately waist/body level for better AR framing.

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

`playerID` (1–5) is assigned by `Networker.assignAndWritePlayerID()` after the SyncEntity is ready and `clientID` is known. The assignment is stable for the cloud session **unless the player dies or leaves**: `handlePlayerDeath` zeroes the dead player's color slot on all remaining clients. On **respawn**, `respawn()` calls `assignAndWritePlayerID()` again, which — because the empty-slot search is seeded from `clientID % 5` — usually re-claims the same slot and keeps the player's color (it only changes if another player took the slot during the dead window). A player who fully **leaves** and rejoins later is treated as new and gets a fresh slot. A new player claims the first empty slot. Up to 5 unique colors are supported; a 6th concurrent player takes a **local-only** shared fallback color `(clientID % 5) || 5` **without** writing (or overwriting) any cloud slot — so it never corrupts an active player's color, at the cost of sharing a **color** with an active player (accepted tradeoff; cubes are drawn per cell from the cell's owner clientID, so the color-sharing player's death does not remove the other's cubes). The color index drives both prefab selection for the 3D cubes and the minimap color lookup — both resolve it through `getDisplayVisualID`, so the two are always consistent. Note `playerID` is a display concern only — cell ownership and cleanup are keyed on `clientID`.

---

## Networking Architecture (SpectaclesSyncKit)

### SyncEntity

One `SyncEntity` (`gridSyncEntity`) is created on the `Networker` component. All `StorageProperty` instances are added to this entity. The entity manages cloud store access (`canIModifyStore()`, `currentStore`) and event routing. This cell grid (plus the five color slots and the death RPC) is the **only** networked game state: the world cubes are local objects each client draws from it, and the SyncKit `Instantiator` is not used by any script.

### Storage properties

`StorageProperty.manualVec2(key, defaultValue)` creates a named, typed cloud property. Adding it to the sync entity registers it for cloud synchronization. Once added, the property is never removed — it persists for the session.

**Maximum theoretical cells**: 40×40 = 1,600. In practice only visited cells get properties.

#### Raw store access (leave sweep only)

`gridSyncEntity.currentStore` is a public `GeneralDataStore` supporting `getAllKeys()` / `getVec2(key)` / `putVec2(key, value)` without any StorageProperty (SyncKit itself uses `getAllKeys()` in `StoragePropLookup`; the store replica is a complete snapshot by entity-ready). The **one sanctioned raw-access site** is the full-store leave sweep (`sweepStoreForDepartedClient` — see Death handling), under three constraints that any future raw access must also honor: never raw-write a key this client holds a `StorageProperty` for (SyncEntity drops self-echoes, so the local property would go permanently stale — go through the property instead); never use `store.remove()`/`clear()` to propagate a change (SyncEntity doesn't wire `onStoreKeyRemoved`, so subscribed clients would never see it — write zeros via `putVec2`); a raw `putVec2` **does** fire `onAnyChange` on every *other* client subscribed to that key, so raw writes integrate with the interceptor machinery.

#### Store-level update events (leaderboard + world cubes)

`gridSyncEntity.storeCallbacks.onStoreUpdated` fires `(session, store, key, updateInfo)` for **every key** in the entity's store — `StoreEventWrapper` filters by the store's network ID only, never by key — so it reports changes to cells this client holds no `StorageProperty` for. The per-cell feed (`noteCell` — leaderboard tally and world cubes) uses it to track claims and stakes across the whole grid without subscribing; it is how a far-away player's cubes appear and disappear on this client. Whether a client's **own** writes come back through it is unverified, so local writes are noted at the write site instead (`noteCell` is idempotent, so either behavior is correct).

#### Reading lazily-subscribed properties: `currentValue` vs `currentOrPendingValue`

This is a non-obvious SpectaclesSyncKit gotcha that burned us on the minimap.

When `addStorageProperty` is called and the key already exists in the cloud store (another player wrote it earlier), SpectaclesSyncKit calls `storageProperty.silentSetCurrentValue(existingValue)` internally. That method sets `currentValue` and `pendingValue` — but **not** `currentOrPendingValue`. `currentOrPendingValue` stays at the default value from the property constructor (`vec2.zero()` in our case).

| Field | Set by `silentSetCurrentValue`? | Set by `applyRemoteValue` (future updates)? | Set by `setPendingValue` (local writes)? |
|---|---|---|---|
| `currentValue` | ✓ | ✓ | ✗ (at call time — see below) |
| `pendingValue` | ✓ | ✓ | ✓ |
| `currentOrPendingValue` | **✗** | ✓ | ✓ |

**Rule**: use `prop.currentValue` when reading a property that may have been lazily subscribed after the cloud already had a value for it. `currentOrPendingValue` is only reliable for properties that were subscribed before any remote writes, or for reads after at least one remote update has arrived post-subscription.

**Pending-write promotion (verified in the SyncKit sources)**: `setPendingValue` does not touch `currentValue` *at call time*, but on the unowned grid store (`canIModifyStore() === true` on every client) the pending value is **promoted to `currentValue` locally at the next LateUpdate flush** (`SyncEntity` send-loop → `_checkCurrentValueChanged`, which also fires `onAnyChange` with a `null` `updateInfo`). So the on-device blind window where only `currentOrPendingValue` sees a fresh local write is **sub-frame**; the durable staleness hazard is **cross-client late arrival** (a write flushed to the cloud whose author died/left before other clients received it) — which is what the death sweep's `currentOrPendingValue` matching and the ghost interceptors handle. Also note `silentSetCurrentValue` fires **no events** — seeded values bypass `onAnyChange` entirely (hence the `getCellProperty` seed-check).

### Write strategy

`updateCellValue()` selects write mode based on:
- `description.includes("CONVERSION") || description.includes("INTERIOR")` AND `canIModifyStore()` → `setValueImmediate()` (synchronous write to cloud store)
- Otherwise → `setPendingValue()` (asynchronous; queued for next sync)

The local cache write always accompanies the cloud write, ensuring `getData()` returns the new value immediately without waiting for cloud confirmation.

### Event (RPC) system

`sendEvent(eventName, data, onlySendRemote?)` broadcasts to all peers via the SyncEntity; the local echo is **synchronous** (dispatched in the same call stack) unless `onlySendRemote` is passed. `onEventReceived.add(eventName, callback)` registers a listener — reception works even before the entity is ready (the message channel subscribes at construction), while *sending* on a not-ready entity silently drops. `vec2`/`vec3`/`vec4`/`quat` payloads round-trip through the JSON serializer as real types. Death events use this system (`"playerDeathEvent"`, `vec3(deadPlayerID, killerID, victimVisualID)`) because they need to fire immediately and don't need persistent storage. RPC messages and realtime-store operations travel **different channels** — cross-channel arrival order is not guaranteed, which is why the death path can't rely on event-vs-store ordering (see Ghost interceptors).

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
        │       └─▶ PlayerVisuals.updateMiniMapNetworked()   (background baseColor + stake-dot overlay, changed-only)
        │               reads prop.currentValue for all 25 cells in 5×5 window
        │               background square = claim/white/gray; stake dot (applyStakeDot) = staker color
        │               colors by player visual ID via Networker.getDisplayVisualID()
        │
        ├─▶ if Networker.shouldRedrawLeaderboard():          [redraw only when a score / presence / color slot changed]
        │       Networker.getLeaderboard()                   (from the incremental claim tally; clears leaderboardDirty)
        │       └─▶ PlayerVisuals.updateLeaderboard()        (top 3 rows + own row, changed-only)
        │
        ├─▶ if DEAD: LocationTracker.handleRespawnCountdown()  [every tick while dead]
        │       checks Networker.isLegalSpawnCell() — blocked (occupied/OOB) resets to 3.0s
        │       on 0: Networker.respawn() + sendData()  (fresh home claim at current cell,
        │             re-verified by the firstClaim gate at write time)
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
                    │  (firstClaim first: home claim only on a legal spawn
                    │   cell — else deferred; then the ghost-stake kill gate:
                    │   a stake by an absent player is cleared, not lethal)
               ┌────┴─────────────────────────────┐
               │                                  │
          stake cell                     return to own claim
     (present staker → death RPC             │   ◀── ALSO entered when a
      vec3(dead, killer, visualID);          │       present enemy's stake
      but on your OWN claim it routes         │       sits on your OWN claim
      right instead → closes the loop)       │       (kill + close loop)
               │                                  │
               ▼                                  ▼
    updateCellValue(claimed, self)   addStakedRegionToClaim()
    stakeList.push(gridPos)              │  clearDeferredStakes()
      (kill cell: cube shown now via     │
       deferredStakeKeys, cloud write    ├─ convertStakesSequentially()
       deferred 500 ms)                  │      updateCellValue() × N (40ms each)
                                         │
                                         └─ findAndFillEnclosedRegion()
                                                claimInteriorCellsSequentially()
                                                updateCellValue() × M (50ms each)
```

```
Cell value change   [event-driven — any client's write, anywhere on the grid]
   sources: updateCellValue (own write) · cell onAnyChange (subscribed cells) · onStoreUpdated (every key)
            · recountClaimsFromStore (join seed + debounced recount) · leave-sweep raw putVec2
        │
        ▼ Networker.noteCell(key, claimOwner, stakeOwner)        (returns at once if neither owner changed)
        ├─▶ claim owner changed: claimCounts ± 1, leaderboardDirty
        ├─▶ scheduleLeaderboardRecount()                          (one full recount 3 s later, if none queued)
        └─▶ drawCellCubes(key) → PlayerVisuals.setCellCubes()     (LOCAL cubes; rebuilds only the part that changed;
                                                                   height = local viewer's device height at draw time)
```

```
Device pose   [every frame — PlayerVisuals.onUpdate]
        ├─▶ LocationTracker.getDeviceTrackerRotation() → rotatePlayerArrow()    (heading; memoized in previousRotation)
        └─▶ LocationTracker.getMiniMapArrowOffset()    → positionPlayerArrow()  (sub-cell slide; memoized in previousArrowOffset;
                offset measured from Networker.getMiniMapWindowCenter() → wraps exactly when
                getMiniMapCells re-centers the window, so the arrow stays glued to map content)
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
| `RESPAWN_FLOOR_S` | `3.0s` | `Networker` (exported) | Shared respawn floor — `LocationTracker.respawnDuration` derives from it; anchor of the TTL invariant below |
| Respawn countdown | `= RESPAWN_FLOOR_S` | `LocationTracker` (`respawnDuration`) | Countdown before a dead player respawns |
| Respawn tick | `0.10s` | `LocationTracker` (`respawnTick`) | Countdown decrement per position tick (matches poll rate) |
| `MAX_SAFE_FLOAT32_INT` | `0xFFFFFF` | `LocationTracker` | Max clientID to avoid float32 precision loss |
| Death event name | `'playerDeathEvent'` | `Networker` | RPC event name for broadcast kills (payload `vec3(dead, killer, victimVisualID)`) |
| `RECENTLY_DEAD_TTL_MS` | `2000ms` | `Networker` | Ghost-write interception window after a death — **must stay under `RESPAWN_FLOOR_S`** or the respawned home claim gets eaten; `onAwake()` prints a `CONFIG ERROR` and clamps if violated (TD-14) |
| `LEAVE_RESWEEP_DELAYS_S` | `[2.0s, 8.0s]` | `Networker` | Leave-only late store re-sweeps for cell writes still in their network round-trip at cleanup time |
| `STORE_SWEEP_CHUNK` | `40` | `Networker` | Heal writes per chunk in the full-store leave sweep |
| `STORE_SWEEP_CHUNK_DELAY_S` | `0.05s` | `Networker` | Pause between leave-sweep heal chunks (matches the 40–50 ms write-pacing philosophy) |
| `SCORE_PER_CELL` | `10` | `Networker` | Leaderboard points per claimed cell |
| `LEADERBOARD_RECOUNT_DELAY_S` | `3.0s` | `Networker` | Debounce before the full store recount that reconciles the tally and the cubes after cell changes |
| Deferred stake write | `0.5s` | `Networker.sendData()` | Delay before the cloud write of a stake placed on a kill cell (shown locally meanwhile via `deferredStakeKeys`) |
| Cube height drop | `scale / 6` | `PlayerVisuals.cubeHeight()` | Cube y = local viewer's device y − 33.3 cm |

---

## Scene configuration reference (current state)

**`Instantiator` component and its `prefabs[]` list (15 game prefabs)**:
- Now unused — no script references it (the `networkedInstantiator` inputs on `PlayerVisuals` and `LocationTracker` are gone). It can be removed in Lens Studio
- The 15 prefab `@input`s on `PlayerVisuals` (`p1–p5 claimCellObj / stakeCellObj / stakePillarObj`) are still required: `setCellCubes` instantiates from them ✓

**`RespawnCountdownText` (screen-space `Text`, wired into `PlayerVisuals.respawnCountdownText`)**:
- Centered in the AR view, large readable font ✓
- Starts hidden — toggled at runtime by `PlayerVisuals.show/hideRespawnCountdown()` ✓
- Separate object from the `uiText` debug HUD ✓

**`LeaderboardEntry1`–`4` (screen-space `Text`, wired in order into `PlayerVisuals.leaderboardRows`)** ✓:
- Under `Orthographic Camera > Full Frame Region`; font size 32. Their rects and alignment are overwritten at runtime by `PlayerVisuals.layoutLeaderboard()`, so only font/style settings in the editor matter
- `showHUDText` unticked on `PlayerVisuals` in normal play (the debug HUD occupies the same corner)

**`SessionController [CONFIGURE_ME]` scene object**:
- `connectedLensModule` ✓
- `locationCloudStorageModule` ✓
- `isColocated: true` ✓
- `locatedAtComponent` → `ColocatedWorld [CONFIGURE_ME]`'s LocatedAtComponent ✓
- `skipUiInStudio: false` — multiplayer join UI shows in Studio preview; set to `true` to skip it during iteration

**`ColocatedWorld [CONFIGURE_ME]` scene object**:
- Has `LocatedAtComponent` directly on it ✓
- Parent of every world cube: `PlayerVisuals.getCubeParent()` reaches it through `SessionController.getLocatedAtComponent()`

The scene still contains leftover example objects from the SpectaclesSyncKit template that are not used: `SessionControllerExampleTypescript`, two `SessionControllerExampleJavascript` objects, `InstantiatorExampleAuto`, a `SyncTransform` demo object, and a `SyncMaterial` demo object (disabled). These can be deleted.

---

## Known Incomplete Areas

> **See [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md)** for the status-tracked defect & tech-debt
> register (severity, status, file+symbol, impact, fix hints). The prose below is the
> narrative source for the open items; the register is the checklist. Keep the two in sync.
> Fixed items are pruned from both docs to reduce bloat — git history preserves resolved detail.

### Game mechanics

- **Out-of-bounds death**: Walking outside the 40×40 arena kills the local player. The alive branch of `LocationTracker`'s position loop checks `Networker.isInBounds(gridPos)` and calls `Networker.killLocalPlayer()` when off-grid; the respawn countdown then treats out-of-bounds as `blocked` (same as standing on territory) so the player must return in-bounds onto open ground before respawning. The grid write/read paths themselves still don't validate bounds — the gate lives in `LocationTracker`.
- **Spawn legality (shared rule)**: both the initial join's home claim and the respawn claim are gated by `Networker.isLegalSpawnCell` (in-bounds + fully open). A join or respawn on an occupied cell **defers** the home claim (with no on-screen feedback at join — only a log; the respawn path shows the countdown UI) until the player reaches open ground, so a co-located start can no longer erase another player's territory. Residual (unavoidable client-side): the legality read is of *local* state — an enemy claim still in cloud flight (written remotely but not yet arrived here) is invisible to the check, so two players claiming the same cell within one network round-trip still last-wins.
- **Respawn edge cases**: Respawn is implemented (`Networker.respawn()` + `LocationTracker.handleRespawnCountdown()` — a 3-second countdown that resets whenever the player stands on any claimed/staked cell **or is outside the arena**, then places a fresh home claim, re-verified at write time by the `firstClaim` gate). Remaining edge: the respawning player's color can change if another player claimed their freed slot during the dead window.
- **Multiplayer kill by territory**: `sendData()` only kills the owner of a **stake trail**. Entering an enemy's **claimed** cell does not kill the entering player (the `else`-branch just stakes over the enemy claim). To implement: in the `else`-branch, check `if (claimedBy !== 0 && claimedBy !== ID)` and fire a `playerDeathEvent` for the entering player.
- **Self-collision death (intended mechanic)**: stepping back onto a cell you staked earlier this life — your own **trail** (a cell you do **not** own) — kills you, Paper.io-correct self-collision, documented in the `sendData` decision tree (step 3). A stake of yours sitting on your own *claimed* territory does **not** self-kill: that degenerate `(A,A)` cell suppresses the death and closes/no-ops the loop instead (and such cells are no longer produced anyway, now that returning to your own claim closes the loop rather than re-staking). Known limitation for a future kill feed: the self-collision payload (`killerID === deadPlayerID`) is indistinguishable from a voluntary-leave / out-of-bounds death, so causes need a distinct flag before they can be labeled (see FEAT-3).

### World cubes

- **Local-cubes refactor is untested on device (KNOWN_ISSUES TD-16)**: world cubes are now local objects drawn from the cell grid (`Networker.noteCell` → `PlayerVisuals.setCellCubes`) instead of networked Instantiator spawns. The change has not yet been verified in a multi-device session.
- **Cube height comes from the local viewer**: each client places each cube at its own device height (minus `scale/6`) at the moment it draws it; height is not synced, so viewers can disagree on a cube's height. Accepted for now, not yet tuned.
- **A late joiner builds every existing cube at once**: the grid-ready seed instantiates all cubes already in the session in one synchronous pass (up to 1600 cells). Accepted for now, not yet tuned.

### Networking

- **Death cloud cleanup is best-effort for KILLS only (KNOWN_ISSUES NET-5, leave residual closed)**: `handlePlayerDeath` (Phase 3) only zeroes cells present in the running device's `gridCells` map (cells that have been `getCellProperty`'d), though it now matches pending values too (`currentOrPendingValue`). For a **leave**, the full-store sweep (`sweepStoreForDepartedClient` — immediate, re-swept at +2 s/+8 s, and replayed at ready) additionally clears the leaver's cells from the entire cloud store, including never-subscribed regions, so late joiners inherit a clean store; the seed-check and `sendData`'s kill gate remain as second-line healing. The durable residual is **kill-ghosts**: a killed-but-still-connected player's old-life cells in never-subscribed regions encountered after the 2 s recently-dead window — which, since cubes mirror the cells, also show as that player's cubes — (same clientID as their new life, so they cannot safely be distinguished — a full-store sweep would erase the respawned life's claims, which is why the sweep is structurally leave-only). Also residual, vanishingly narrow: every remaining client disconnects before any sweep completes while the session store persists.
- **Hard-crash presence assumption**: the leave path (departed tracking, re-sweeps, kill gate) relies on the platform eventually firing `onUserLeftSession` for a disconnected peer — nothing in the SDK provides an independent presence/heartbeat signal. A hard crash that never produces a leave event leaves that player "present" to `isClientPresent` until the session ends. The caveat applies equally to the Set-backed presence cache (`presentClientIDs`) — the Set is only as fresh as the join/leave events that maintain it.
- **clientID 0 collides with "unclaimed"**: `getDeterministicPlayerId` returns `0` if `displayName` is null. All death paths now guard against ID 0 (`handlePlayerDeath` drops it — a 0-ID sweep would wipe every subscribed cell; the RPC listener, `killLocalPlayer`, and `onUserLeftSession` mirror the guard), but a player who actually joins with a null display name would have their claims treated as unclaimed cells in `sendData()`'s decision tree, causing them to perpetually re-stake their own territory instead of triggering loop closure (the *join* path is still open — KNOWN_ISSUES NET-2).
- **Simultaneous death-cleanup writes (KNOWN_ISSUES NET-6)**: When multiple remaining clients all handle a death event (via RPC or `onUserLeftSession`), each independently writes the same per-component clear (zeroing only the dead player's own claim/stake, preserving any other player's value in the cell) to the same cloud cells. These writes are idempotent but produce redundant cloud traffic proportional to `(remaining players) × (dead player's subscribed cells)`. The ghost interceptors add a documented, bounded instance of the same class (every client that sees a ghost write issues the same clear; `equalsCheck` suppresses identity writes), and the full-store leave sweep adds another (every remaining client sweeps, but writes are read-gated + changed-only + re-validated per chunk, so duplicates exist only within the RTT window). Single-cleaner election was deliberately rejected: it requires agreement on the present set at the exact moment it's churning, and an elected cleaner can itself leave mid-sweep.
- **Player count cap (partial)**: `assignAndWritePlayerID` supports up to 5 unique colors. A 6th concurrent, non-rejoining player finds no free slot and takes a **shared fallback color** (`playerID = (clientID % 5) || 5`) **without writing to the cloud slot table** — so an active player's slot is never corrupted (former defect NET-7). The residual tradeoff (documented, accepted): the 6th player shares a color with an active player on the minimap and in 3D. (Their death does not remove the co-colored player's cubes — cubes follow cell ownership by clientID, not color.) There is still no hard cap enforcing ≤5; a full cap + spectator/queue was deferred.

### Code quality

- **`getData()` ID parameter used only for logging**: `getData(ID, xpos, zpos)` references `ID` only in log statements (an opening trace and a "still staked by ID" warning), never for game logic. It's a legacy artifact; removing it means dropping those log lines too (see KNOWN_ISSUES TD-1).
- **`UnionFindLoopDetection.ts`**: Entirely commented out. The `LoopDetection` class compiles as an empty component. The Union-Find approach was abandoned in favor of the flood-fill in `Networker.findAndFillEnclosedRegion()`.
- **`computeClientID` duplicated**: The FNV-1a hash exists in both `LocationTracker.getDeterministicPlayerId` and `Networker.computeClientID`. If the hash algorithm ever changes, both must be updated. Could be extracted to a shared utility module.
- **Gated logging still builds the string every call (KNOWN_ISSUES TD-9)**: `log()` checks `showLogs` *inside* the method, so every `this.log("…" + a + …)` concatenates its argument before the call even when logging is off. In the 10 Hz loop this is real per-tick allocation on device — worst in `getData()` (~10 concatenations/tick), `sendData()`, and the `onAnyChange` cell listener. Guard hot call sites with `if (this.showLogs)`, or delete the per-tick `getData()` call (also TD-1).
- **Write-mode dispatch by label (KNOWN_ISSUES TD-15)**: `updateCellValue` dispatches immediate-vs-pending write mode by substring-matching the human-readable `description` label, which every new writer string silently opts out of (pass an explicit mode flag).
- **Leftovers from the local-cubes refactor**: `visualIDHint` (the `handlePlayerDeath` parameter, the death payload's third component, the hint resolved in `onUserLeftSession` and stored in `pendingDeathCleanups`) and `realWorldCoords` (threaded through `sendData` and the conversion chains) are still passed around but read by nothing; `LocationTracker`'s `clientID == null` tick guard can no longer trigger; several comments in `Networker.ts` still describe the removed visual sweeps; and the scene still holds the unused `Instantiator` component.
- **Unbounded `gridCells` subscription growth (KNOWN_ISSUES TD-10 — churn fixed, ceiling remains)**: the minimap is now event-driven (`shouldRedrawMiniMap` gate), so `getMiniMapCells`/`getCellProperty` runs only on a redraw, not every tick — new cells are subscribed at most once per cell-*entry*. But each new cell still permanently adds a `StorageProperty` + cloud subscription + `onAnyChange` listener that is never removed, so a long traversal still accretes toward the 1600-cell ceiling (just far more slowly). Distinct from the best-effort cloud-cleanup item above (that's about stale *values*; this is about local subscription/listener cost).

### Stretch features

- **Kill feed / death announcement**: Death events are logged to `print()` only. A UI overlay showing who killed whom would use the `killerID` field already present in `playerDeathEvent`'s `vec3(deadPlayerID, killerID, victimVisualID)` payload — but note `killerID === deadPlayerID` is ambiguous between self-collision (an intended mechanic — see the `sendData` decision tree), voluntary leave, and out-of-bounds death (KNOWN_ISSUES FEAT-3).

---

## Lens Publication — Known Submission Blockers

A submission to Snap's Lens Explorer was rejected with the generic "Invalid Lens Submitted / violates our Guidelines" boilerplate. The likely causes, in priority order, against the [Spectacles publishing requirements](https://developers.snap.com/spectacles/get-started/start-building/publishing-lens) and [Lens Submission Guidelines](https://developers.snap.com/lens-studio/publishing/submitting/submission-guidelines):

0. **Location + Connected Lenses — TWO independent causes** — submissions are rejected with a *specific* error: *"This Lens tracks a Snapchatter's location and also uses Connected Lenses or a Remote API. That combination is not allowed, because a Snapchatter's location cannot be shared with other users."* Snap's [Transparent Permission](https://developers.snap.com/spectacles/permission-privacy/transparent-permission) system blocks a sensitive permission (Location) combined with a connectivity type (Connected Lenses) at publication time. The Connected Lenses half (`ConnectedLensModule`, `LocationCloudStorageModule`, `isColocated: true`) is load-bearing for multiplayer and cannot be dropped, so the **location half must stay at exactly zero**.

   **Cause A — `require("ProcessedLocationModule")` (fixed)**: `Assets/GrantWork/Scripts/Requirements.ts` was an orphaned stub component (class `NewScript`, empty `onAwake()`, attached to nothing in `Scene.scene`) whose first line was that `require`. Per [Permissions & Privacy](https://developers.snap.com/spectacles/permission-privacy/overview), `ProcessedLocationModule` **is** the "Location – Coarse" permission (`RawLocationModule` is "GPS – Precise"); a bare `require()` declares the permission even though no location API is ever called. **Fix applied**: deleted `Requirements.ts` + `.ts.meta` and stripped the vestigial GPS fields (`latitude`/`longitude`/`altitude`/`horizontalAccuracy`/`verticalAccuracy`/`timestamp`/`locationSource`/`locationService: LocationService`/`repeatUpdateUserLocation`) from `LocationTracker.ts`. Zero gameplay impact — the game's only position source is `playerTracker: DeviceTracking` → `getTransform().getWorldPosition()` (AR world space, cm, relative to the colocated origin); GPS was never consumed.

   **Cause B — a `LocationAsset` assigned to the `LocatedAtComponent`**: the `ColocatedWorld [CONFIGURE_ME]` object's `Located At` component had its `Location` field pointing at `Assets/GrantWork/GameLocation.location`. That is the **Custom Location AR** opt-in — the signature Snap classifies as location tracking. Snap's own shipped `SpectaclesSyncKit.prefab` leaves this field **empty** (`Location: !<reference> 00000000-0000-0000-0000-000000000000`) for standard colocated multiplayer. Verified against the SyncKit sources: `SessionController` hardcodes `mappingOptions.location = LocationAsset.getAROrigin()`, so the colocated map **never** uses `locatedAtComponent.location`; the field only feeds `getCustomLandmark()` and `getMapExists()`, which are consumed solely by SyncKit's mapping-flow UI (`JoiningController`, `JoiningState`, `Mapping{Successful,Unsuccessful}State`) and by **no** PapAR script. Assigning it makes `getMapExists()` return true immediately, short-circuiting the normal colocated scan flow. **Fix**: clear the `Location` field in Lens Studio and delete `GameLocation.location`; colocation is unaffected, but the standard scan/join mapping UI returns.

   **Guard rail**: never `require()` `ProcessedLocationModule`/`RawLocationModule`, and never assign a `LocationAsset` to a `LocatedAtComponent` in this project. Audit command — all four of these must return nothing: `require\(` in `Assets/`, and any `ProcessedLocationModule|RawLocationModule|LocationService|DeviceLocationTrackingComponent` in `Assets/` or in the extracted `Packages/*.lspkg` (they are ZIP archives — `unzip` them before grepping; an in-place text grep silently skips them). `LocationCloudStorageModule` itself is **required for colocated mapping** and is not a location-permission trigger per Snap's permission table.

1. **Trademark / IP** — the lens name `PapAR` and the "Paper.io-inspired" framing trade on Paper.io, a trademarked game by Voodoo. IP issues almost always trigger the generic boilerplate rejection rather than specific feedback. **Fix**: rename the lens to something non-derivative (e.g. "Territory AR", "Claim Trails") and scrub references to Paper.io from the lens name, description, release notes, and any in-game text.
2. **Encouragement of real-world risky behavior** — the core loop has players physically racing across an ~80m × 80m area in AR glasses. Snap explicitly bans content that encourages risky real-life behavior. **Fix**: add an onboarding screen warning players to play in a safe, open area clear of obstacles and traffic, and consider shrinking the play area.
3. **Missing required submission metadata** — eligibility requires all of: custom icon, 3×4 preview image, concise description, release notes, reviewer test notes, version number displayed at launch, and on-activation visuals communicating the objective. None of these are currently wired into the scene.
4. **Quality / stability flags for solo reviewers** — the multiplayer-only experience feels empty when tested solo. (Three former stability blockers are resolved: permadeath — players now respawn after a 3-second countdown, so a reviewer who dies early is no longer stuck; the "conversion continues after death" glitch — conversion/interior chains now abort immediately on death via `conversionEpoch`, so a dead player's chains stop writing cells; and the death-cleanup races that rarely left orphan 3D volumes or stale minimap cells after a death — orphan volumes are ruled out by construction now that world cubes are local objects drawn from the cell grid (no networked spawn left to race; this refactor is not yet verified on device), and stale cells are handled by pending-aware sweeps, ghost interceptors, and the join-window death replay.)
