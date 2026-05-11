# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**soloPapAR** is a Paper.io-inspired AR game for **Snap Spectacles** (AR glasses), built in **Snap Lens Studio 5.12.1** using **TypeScript**. Players physically walk in the real world to stake trails, loop back to their own territory, and convert the enclosed area into permanent claims. The AR grid and all player objects are overlaid on the physical world at 1:1 scale (2 meters per cell).

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

Four active `BaseScriptComponent` classes. Each is attached to a scene object in the Lens Studio scene and wired together via `@input` fields.

### `LocationTracker.ts` — Entry point / position polling

**Lifecycle**: `onAwake()` registers two independent callbacks:
- `SessionController.notifyOnReady()` → sets `clientID` (from FNV-1a hash of display name) and calls `Networker.setPlayerID(clientID, users.length)`.
- `networkedInstantiator.notifyOnReady()` → starts the position loop by calling `getDeviceTrackerPosition()`.

The two callbacks are independent — the position loop can start before `clientID` is set if the instantiator becomes ready before the session controller. In that case, `clientID` would be `undefined` for the first few `sendData()` calls, which is a latent race condition.

**Position loop**: A `DelayedCallbackEvent` that self-resets every **0.3 seconds**, continuously calling itself via `getNewPosition.reset(0.30)`. On each tick it:
1. Reads `playerTracker.getTransform().getWorldPosition()` (AR world space, cm)
2. Converts to grid coords via `worldCoordsToGridPos()`
3. Calls `PlayerVisuals.updateHUDText()` every tick
4. Calls `Networker.getMiniMapCells(gridPos.x, gridPos.y)` and passes the result to `PlayerVisuals.updateMiniMapNetworked()` every tick — this drives the live networked minimap
5. Calls `Networker.getData(clientID, gridPos.x, gridPos.y)` every tick — result is used only for debug logging (`print("cell: " + gridPos + " is claimed by: " + claimedBy + ...)`), not for game logic
6. Only calls `Networker.sendData()` if `Networker.gridReady` is true AND the player has moved to a **new cell** (checked by `PlayerVisuals.isInSameCell()`). The `gridReady` guard must wrap the `isInSameCell` call — `isInSameCell` has the side effect of updating `prevGridPos` on every false return, so calling it before `gridReady` would permanently consume the player's starting cell entry without placing a home claim.

Note: `sendData()` performs its own independent read of the cell state — it does **not** use the return value from the `getData()` call above.

**Player ID assignment**: On `SessionController.notifyOnReady()`, the local Snapchat display name is hashed via `getDeterministicPlayerId()` (FNV-1a) to produce `clientID`. `Networker.setPlayerID(clientID, sessionController.getUsers().length)` is called at this point — `playerNumber` is the count of users currently in the session.

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
- `playerID: number` — visual color set index `1–5`; assigned by `assignAndWritePlayerID()` and stable for the lifetime of the cloud session

#### Player color mapping

Five `StorageProperty<vec2>` slots (`playerColorSlot_1` through `playerColorSlot_5`) are registered at grid-ready time. Each stores `vec2(clientID, playerID)`. `playerID` determines which slot is used (slot index = `playerID - 1`).

Assignment is handled by `assignAndWritePlayerID()`, called once `gridReady` is true and `clientID` is known (whichever happens last):
1. **Rejoin detection**: scan all 5 slots for a matching `clientID`. If found, reuse the stored `playerID` — no cloud write needed. This guarantees a returning player always gets their original color.
2. **New player**: scan for the first empty slot (`currentValue.x === 0`), starting from `clientID % 5` to reduce simultaneous-join collisions. Claim it with `setPendingValue(vec2(clientID, slotIdx+1))`.
3. **All slots full** (6+ players): hash fallback `(clientID % 5) || 5`, overwrites that slot.

**Slot freeing on death/leave**: `handlePlayerDeath` scans slots and writes `vec2.zero()` to the slot whose `currentValue.x` matches the dead player's clientID. This runs on all remaining clients simultaneously (idempotent). A rejoining player will no longer find their old slot and will be assigned a new one — intentional, since leaving is treated as permanent death.

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
2. **`stakedBy != 0`**: The cell has someone's stake in it. Fire `playerDeathEvent` RPC with `vec2(stakedBy, clientID)` — killing whoever owns that stake.
3. **`claimedBy == ID`**: Player stepped onto their own claimed territory. Call `addStakedRegionToClaim()` to convert the pending trail.
4. **Else** (unclaimed or enemy-claimed): Push `vec2(xpos, zpos)` to `stakeList`, write `vec2(existingClaim, ID)` to cloud, spawn a stake visual.

#### Stake → claim conversion pipeline

`addStakedRegionToClaim()` → guarded by `isPerformingBulkConversion` (boolean mutex).

Steps:
1. Set `isPerformingBulkConversion = true`
2. Call `PlayerVisuals.DestroyAllStakes()` immediately
3. Copy `stakeList` to `stakesToConvert`, then clear `stakeList`
4. Call `convertStakesSequentially(stakesToConvert, 0, realWorldCoords, onComplete)`
5. In `onComplete`: call `findAndFillEnclosedRegion(stakesToConvert, realWorldCoords)`, then set `isPerformingBulkConversion = false`

`convertStakesSequentially()` processes one stake per call. For each stake it:
- Reads current cloud value, writes `vec2(clientID, 0)` (claim = self, stake = cleared)
- Spawns a claim visual at that position
- Sets a `DelayedCallbackEvent` of **40ms** before processing the next stake
- Skips ahead on failure without aborting the batch

`claimInteriorCellsSequentially()` works identically but uses **50ms** delays per interior cell.

#### Interior fill algorithm

`findAndFillEnclosedRegion(loop, realWorldCoords)`:
1. Compute bounding box `[minX, maxX] × [minZ, maxZ]` of the stake loop
2. Early return if `maxX - minX <= 1 || maxZ - minZ <= 1` (no interior possible)
3. Build edge list via `getLoopEdges(loop)` — consecutive `vec2` pairs wrap around (last→first)
4. For each candidate `(x, z)` in the interior of the bounding box (exclusive), skip if it's on the loop boundary, then test with `isInLoop(x, z, edges)`
5. Collect all interior cells, then claim them via `claimInteriorCellsSequentially()`

`isInLoop()` uses ray-casting: cast a horizontal ray rightward from `(x, z)`, count edge crossings. An edge `(x1,y1)→(x2,y2)` crosses if `(y1 > z) !== (y2 > z)`, at `xCross = (x2-x1)*(z-y1)/(y2-y1) + x1 > x`. Odd count = inside.

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
- `localCellState.clear()`, `localCacheTimestamps.clear()`
- `PlayerVisuals.DestroyAllStakes()` and `PlayerVisuals.DestroyAllClaims()` — these operate on `spawnedClaims`/`spawnedStakes`, which only contain objects spawned by this device, so they are the correct teardown path for self-death.

**Phase 2 — Remote-player visual cleanup** (`else`, guarded by `gridReady`):
- `PlayerVisuals.destroyPlayerVisuals(ID, getPlayerVisualID)` — iterates the Instantiator's internal `spawnedInstances` map (via `as any`) to find and destroy all scene objects whose `_prefab_name` store key starts with `"P" + visualID`. This covers every device: the Instantiator tracks all spawned objects locally on each client regardless of who spawned them.

**Phase 3 — Cloud cleanup** (all clients, guarded by `gridReady`):
- Iterates `gridCells` — any cell whose `currentValue.x === ID` or `.y === ID` is zeroed via `updateCellValue(…, "DEATH CLEAR")`. Best-effort: only covers cells that have been `getCellProperty`'d on this device. Cells the dead player visited but no remaining client ever subscribed to will remain stale in the cloud until another player passes through them.
- Frees the dead player's color slot: scans `playerColorSlots`, finds the slot whose `currentValue.x === ID`, writes `vec2.zero()` via `setPendingValue`. This makes the color available for the next joining player.

`computeClientID(displayName: string): number` — private method on `Networker`, identical FNV-1a algorithm as `LocationTracker.getDeterministicPlayerId`. Used only in the `onUserLeftSession` handler to recover a clientID from a display name. Guards against null input (returns 0) — if the result is 0, cleanup is skipped since clientID 0 collides with the "unclaimed" sentinel.

Note: after death, `isAlive = false` prevents `sendData()` from doing anything. There is currently no respawn mechanic — the player is permanently dead until the lens is restarted.

#### Cloud storage & local cache

**Lazy property creation** via `getCellProperty(x, y)`: checks `gridCells` Map first; if missing, creates `StorageProperty.manualVec2("cell_x_y", vec2.zero())`, adds it to `gridSyncEntity`, attaches an `onAnyChange` listener, stores in the map.

**`updateCellValue(x, y, newValue, description)`**: the single write path. Always:
1. Uses `setValueImmediate()` if description contains `"CONVERSION"` or `"INTERIOR"` and `canIModifyStore()` is true; otherwise uses `setPendingValue()`
2. Always writes to `localCellState` map with current timestamp

**`getData(ID, x, y)`**: read path. The `ID` parameter is accepted but **never used** inside the function body — it exists in the signature as a legacy artifact. Checks `localCellState` first (uses if cache age < **5000ms**); falls back to `cellProp.currentValue`; returns `vec2.zero()` on any error. Note: `sendData()` does NOT call `getData()` — it reads cell state directly from `localCellState`/`currentValue` internally. `getData()` is called every tick by `LocationTracker` for debug logging only.

**`getMiniMapCells(centerX, centerY)`**: public minimap data provider. Returns early with 25 `vec2.zero()` values if `!gridReady` — this prevents `getCellProperty` (and thus `addStorageProperty`) from being called before the SyncEntity is ready, which would leave `currentValue` permanently at `vec2.zero()` since SpectaclesSyncKit only calls `silentSetCurrentValue` when the entity is ready at the time of `addStorageProperty`. Once ready, iterates the 5×5 window centred on `(centerX, centerY)`, returns `(vec2 | null)[]` in row-major order (index = `(dy+2)*5 + (dx+2)`). For each in-bounds cell: calls `getCellProperty` (creating a subscription if new), checks `localCellState` first, then reads `prop.currentValue`. Out-of-bounds cells are `null`.

> **Critical**: always use `prop.currentValue`, not `prop.currentOrPendingValue`, when reading lazily-subscribed properties. `SyncEntity.addStorageProperty` reads an existing store key via `silentSetCurrentValue`, which sets `currentValue` and `pendingValue` but deliberately skips `currentOrPendingValue`. So `currentOrPendingValue` stays at the constructor default (`vec2.zero()`) for any cell that existed in the cloud before the local client subscribed. `currentValue` is set correctly by both `silentSetCurrentValue` (initial load) and `applyRemoteValue` (all ongoing remote updates).

**`getCellDataReadOnly(x, y)`**: read helper that does NOT call `getCellProperty` — it only reads from `localCellState` and the existing `gridCells` Map via `prop.currentValue`. Useful when you need a value without side-effecting the subscription set. Not used by `getMiniMapCells`.

**`onAnyChange` listener**: Fires whenever the cloud reports any value change for a cell. Always clears the `localCellState` entry unconditionally — cloud is authoritative. The previous conditional clear (only when local cache matched cloud value) left stale cache entries when another player overwrote a pending local write: the mismatch meant the cache was never cleared, and `getMiniMapCells` continued reading the stale local value even though `prop.currentValue` was correct. `getMiniMapCells` also enforces a 5-second TTL on `localCellState` reads as a safety net.

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

**Destruction — remote player** (`destroyPlayerVisuals(clientID, getPlayerVisualID)`): Used when a remote player dies or leaves. Resolves the dead player's visual ID, then iterates the Instantiator's `spawnedInstances` (via `(networkedInstantiator as any).spawnedInstances`) — this map is populated on every client for both local and remote spawns, so it covers all objects regardless of who created them. Finds all entries whose `dataStore.getString("_prefab_name")` starts with `"P" + visualID` (e.g., `"P2ClaimCube"`, `"P2StakeCube"`, `"P2StakePillar"`) and destroys them. Called by `Networker.handlePlayerDeath` in the remote-player path. Note: after `DestroyAllClaims/Stakes` destroys the local player's objects, those now-invalid `SceneObject` references remain in `spawnedInstances` — this is harmless since the player is permanently dead, but would need cleanup if respawn were added.

#### 5×5 minimap

The minimap shows a ±2 cell window around the player on a pre-wired `Image[]` array (`miniMapCells`). The array is row-major: index = `miniMapY * 5 + miniMapX` where X and Y each run 0–4 (player is at 2,2).

**Active path — `updateMiniMapNetworked(cells, getPlayerVisualID)`**: Called every 0.3s by `LocationTracker`. `cells` is the `(vec2|null)[]` returned by `Networker.getMiniMapCells()`. Each cell is colored by `getCellColorFromData()`:
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

`onUpdate()` reads `deviceTracker.getDeviceTrackerRotation()` every frame. If yaw changed, `rotatePlayerArrow(yawRads)` applies `quat.fromEulerAngles(0, 0, -yawRads + π/2)` to the arrow's `ScreenTransform`. The `+ π/2` offset aligns screen space "up" with world-space "forward".

#### HUD text

`updateHUDText(lat, long, gridx, gridy, latOff, longOff)` — despite the parameter names, the caller passes `(gridPos.x, gridPos.y, worldPosition.x, worldPosition.z, 0, 0)`. Displayed as grid coordinates and world position in AR overlay. The parameter naming is a legacy artifact from when GPS coordinates were used.

#### `@input` fields (all assigned in Lens Studio scene)

`uiText`, `screenTransform`, `cellMaterial`, `whiteCell`, `playerArrow`, `deviceTracker`, `networkedInstantiator`, `miniMapCells`, and 15 prefab references: `p1–p5 claimCellObj / stakeCellObj / stakePillarObj`.

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

The `LoopDetection` class exists but its entire implementation is commented out. It was intended to detect loop closure using Union-Find (path compression + union by size), with a helper to convert a stake list to an adjacency list for 4-connected neighbors. This approach was abandoned in favor of the ray-casting fill in `Networker.findAndFillEnclosedRegion()`.

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

`playerID` (1–5) is assigned by `Networker.assignAndWritePlayerID()` after the SyncEntity is ready and `clientID` is known. The assignment is stable for the cloud session **unless the player dies or leaves**: `handlePlayerDeath` zeroes the dead player's color slot on all remaining clients, so a rejoining player cannot reclaim their old color — they will be assigned a fresh slot. A new player claims the first empty slot. Up to 5 unique colors are supported; a 6th player falls back to `(clientID % 5) || 5` and overwrites that slot. `playerID` drives both prefab selection for 3D volumes and minimap color lookup — the two are always consistent.

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
Device position (AR world, cm)   [every 0.3s tick]
        │
        ▼ worldCoordsToGridPos()
Grid coordinates (0–39 int)
        │
        ├─▶ PlayerVisuals.updateHUDText()                    [every tick]
        │
        ├─▶ Networker.getMiniMapCells()                      [every tick]
        │       └─▶ PlayerVisuals.updateMiniMapNetworked()   [every tick]
        │               reads prop.currentValue for all 25 cells in 5×5 window
        │               colors by player visual ID via Networker.getPlayerVisualID()
        │
        ├─▶ Networker.getData()                              [every tick, debug logging only]
        │         (result not used for game logic)
        │
        └─▶ if new cell: Networker.sendData()     [on cell change only]
                    │
                    │ (internal read of localCellState / currentOrPendingValue)
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
| Position poll rate | `0.30s` | `LocationTracker` | How often player position is checked |
| `MAX_SAFE_FLOAT32_INT` | `0xFFFFFF` | `LocationTracker` | Max clientID to avoid float32 precision loss |
| Death event name | `'playerDeathEvent'` | `Networker` | RPC event name for broadcast kills |

---

## Frontend Networking — Resolved Bugs

These bugs were diagnosed and fixed on the `SyncVisualsPlz` branch.

### Bug 1 — Transform not encoded in spawn store (FIXED in code)

`createWorldClaimVolume` and `createWorldStakeVolume` originally passed `undefined` as `InstantiationOptions`. The Instantiator's `onSuccess` callback only fires on the spawning client, not on remote clients. Remote clients reconstruct objects via `instantiatePrefabFromStore()`, which reads `_init_pos` / `_init_scale` keys from the store — keys that are only written when `localPosition` / `localScale` are in `InstantiationOptions`.

**Fix**: both spawn functions now pass `{ localPosition, localScale, onSuccess }` as a single options object. The `onSuccess` callback is used only for pushing to `spawnedClaims` / `spawnedStakes`.

### Bug 2 — Instantiator not parented under `ColocatedWorld` (FIXED in Lens Studio)

The `networkedInstantiator` component had `spawnAsChildren: false` and `spawnUnderParent: null`. All spawned objects went to scene root, breaking `SyncTransform` Location mode (which needs a `LocatedAtComponent` ancestor to exist in the hierarchy).

**Fix**: set `spawnAsChildren → true` and `spawnUnderParent → ColocatedWorld [CONFIGURE_ME]` in the Lens Studio Inspector.

### Bug 3 — `SyncTransform` on `P1ClaimCube.prefab` (REMOVED)

`P1ClaimCube.prefab` had a `SyncTransform` component in `"Location"` mode, which threw during initialization when parented at scene root (no `LocatedAtComponent` ancestor). The component was removed from the prefab.

### Bug 6 — `sendData()` and `handlePlayerDeath()` using `currentOrPendingValue` for cell reads (FIXED in code)

`sendData()` fell back to `cellProp.currentOrPendingValue` when a cell had no local cache entry. On a player's first visit to a cell already claimed/staked in the cloud, `currentOrPendingValue` is `vec2.zero()` (not set by `silentSetCurrentValue`), so the cell appeared unclaimed — causing the player to incorrectly stake it.

`handlePlayerDeath()` iterated `gridCells` using `currentOrPendingValue`. Cells that were in the cloud before this client subscribed had `currentOrPendingValue = vec2.zero()`, so the death handler could miss clearing those cells for the dead player, leaving ghost claims/stakes in the cloud.

**Fix**: both changed to `currentValue`, consistent with the rule applied throughout the rest of the codebase.

### Bug 5 — `getPlayerVisualID` using `currentOrPendingValue` for color slots (FIXED in code)

`getPlayerVisualID` read player color slots via `currentOrPendingValue`. When a remote player joins before the local client, their slot is already in the cloud. On `addStorageProperty`, SpectaclesSyncKit calls `silentSetCurrentValue` which sets `currentValue` but **not** `currentOrPendingValue`. So any slot written before the local subscription read as `vec2.zero()`, the lookup fell through to the fallback `(clientID % 5) || 5`, and remote players were shown in the wrong color.

**Fix**: changed to `currentValue` in `getPlayerVisualID`, consistent with the same rule applied in `getMiniMapCells`. A local player fast-path (`if (clientID === this.clientID && this.playerID) return this.playerID`) was also added to avoid the 100–300ms wrong-color window for the local player's own cells that would otherwise occur because `setPendingValue` does not set `currentValue`.

### Bug 4 — `SyncMaterials` on `P1ClaimCube.prefab` (REMOVED)

`P1ClaimCube.prefab` had a `SyncMaterials` component syncing `baseColor` with `autoClone: false` (all instances sharing one material). The component served no purpose — claim color is baked into the shader — and was removed.

### Bug 7 — Death only cleaned up on dying player's device; player-leave not handled (FIXED in code)

The `playerDeathEvent` RPC listener previously had `if (deadPlayerID === this.clientID)` before calling `handlePlayerDeath`. This meant:
- Remote clients never destroyed the dead player's 3D visual objects (cubes persisted in their scene forever)
- Remote clients never zeroed the dead player's cloud cells from their local subscriptions
- When a player closed the app, no cleanup ran at all — their cells and visuals persisted for the rest of the session

**Fix**: 
1. Removed the client-ID guard — all clients now call `handlePlayerDeath` on every death event.
2. Refactored `handlePlayerDeath` into three phases: local-only state teardown (self), remote visual cleanup via Instantiator `spawnedInstances` lookup, and cloud cell zeroing.
3. Added `SessionController.onUserLeftSession` listener — treats player-leave as self-inflicted death, computing the leaving player's clientID by re-hashing their display name.
4. `handlePlayerDeath` also frees the dead player's color slot so the next joiner can claim it.

**Residual limitation**: Cloud cleanup in Phase 3 is best-effort — only cells subscribed on the running device are zeroed. Cells the dead player visited but no remaining client has `getCellProperty`'d remain stale in the cloud (they have zero visual impact on other players' minimaps until someone walks near them).

---

### Scene configuration reference (current state)

**`networkedInstantiator` (on `PlayerVisuals` scene object)**:
- `prefabs[]`: all 15 game prefabs registered ✓
- `spawnerOwnsObject: false` ✓
- `spawnAsChildren: true` ✓
- `spawnUnderParent` → `ColocatedWorld [CONFIGURE_ME]` ✓
- `autoInstantiate: false` ✓
- `persistenceString: Session` ✓

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

### Game mechanics

- **Respawn**: After `handlePlayerDeath()`, `isAlive = false` and nothing sets it back to `true`. Players cannot move after dying without restarting the lens. If respawn is added: (1) set `isAlive = true` and `firstClaim = true`; (2) teleport or wait for the player to reach a new starting cell; (3) note that `spawnedInstances` on the dying player's device will still have stale references to the destroyed objects — `DestroyAllClaims/Stakes` clears the local tracking arrays but not `spawnedInstances`.
- **Multiplayer kill by territory**: `sendData()` only kills the owner of a **stake trail**. Entering an enemy's **claimed** cell does not kill the entering player (the `else`-branch just stakes over the enemy claim). To implement: in the `else`-branch, check `if (claimedBy !== 0 && claimedBy !== ID)` and fire a `playerDeathEvent` for the entering player.
- **Conversion continues after death**: `convertStakesSequentially` and `claimInteriorCellsSequentially` are `DelayedCallbackEvent` chains that do not check `isAlive`. If a death RPC arrives mid-conversion, `handlePlayerDeath` runs (clearing state and destroying visuals), but the delayed callbacks continue executing — spawning additional claim visuals and writing cells for a dead player until the chain completes.
- **Interior fill correctness**: The ray-casting algorithm works correctly for simple convex and concave loops, but diagonal stake trails can produce ambiguous edge cases since cells are discrete units while the algorithm treats them as point coordinates.

### Networking

- **Death cloud cleanup is best-effort**: `handlePlayerDeath` (Phase 3) only zeroes cells present in the running device's `gridCells` map (cells that have been `getCellProperty`'d). Cells the dead player visited but no remaining client has subscribed to remain stale in the cloud indefinitely. They cause no visual impact on other players' minimaps until someone walks within ±2 cells, at which point `getMiniMapCells` subscribes and reads the stale claim. There is no active purge mechanism.
- **ClientID race condition**: `SessionController.notifyOnReady()` and `networkedInstantiator.notifyOnReady()` are independent callbacks in `LocationTracker.onAwake()`. If the instantiator fires first, the position loop starts with `clientID = undefined`, and the first few `sendData()` calls pass `undefined` as the player ID.
- **clientID 0 collides with "unclaimed"**: `getDeterministicPlayerId` returns `0` if `displayName` is null. `computeClientID` in `Networker` guards against this (skips cleanup if result is 0), but a player who actually joins with a null display name would have their claims treated as unclaimed cells in `sendData()`'s decision tree, causing them to perpetually re-stake their own territory instead of triggering loop closure.
- **Simultaneous death-cleanup writes**: When multiple remaining clients all handle a death event (via RPC or `onUserLeftSession`), each independently writes `vec2.zero()` to the same cloud cells. These writes are idempotent but produce redundant cloud traffic proportional to `(remaining players) × (dead player's subscribed cells)`.
- **Player count cap**: `assignAndWritePlayerID` supports up to 5 unique colors; a 6th player falls back to a hash-derived slot, potentially overwriting another active player's color entry. No hard cap exists in code.

### Code quality

- **`getData()` unused ID parameter**: `getData(ID, xpos, zpos)` accepts an `ID` parameter that is never referenced inside the function body. The parameter exists as a legacy artifact and should be removed.
- **`UnionFindLoopDetection.ts`**: Entirely commented out. The `LoopDetection` class compiles as an empty component. The Union-Find approach was abandoned in favor of the ray-cast fill in `Networker.findAndFillEnclosedRegion()`.
- **`computeClientID` duplicated**: The FNV-1a hash exists in both `LocationTracker.getDeterministicPlayerId` and `Networker.computeClientID`. If the hash algorithm ever changes, both must be updated. Could be extracted to a shared utility module.
- **Stale `spawnedInstances` references after self-death**: When the local player dies, `DestroyAllClaims/Stakes` destroys their objects and clears the local tracking arrays, but the now-invalid `SceneObject` references remain in the Instantiator's `spawnedInstances` map. Harmless with no respawn, but `destroyPlayerVisuals` would hit those stale entries if ever called for self after `DestroyAllClaims/Stakes` already ran.

### Stretch features

- **Sub-cell position indicator on minimap**: The minimap jumps when the player crosses a cell boundary rather than moving smoothly. A fractional position indicator would require computing `fracX = ((worldX % unitsPerCell) + unitsPerCell) % unitsPerCell / unitsPerCell` and `fracZ` similarly, then translating a `ScreenTransform` UI element within the bounds of the center minimap cell. Needs a new `Image` scene object wired into `PlayerVisuals`, updated every 0.3s tick.
- **Score / leaderboard**: No tracking of how many cells each player owns. Could be derived by iterating all subscribed `gridCells` and counting `currentValue.x === clientID`, but this is O(n) per tick and only covers subscribed cells. A dedicated `StorageProperty<number>` per player tracking claim count would be more efficient.
- **Kill feed / death announcement**: Death events are logged to `print()` only. A UI overlay showing who killed whom would use the `killerID` field already present in `playerDeathEvent`'s `vec2(deadPlayerID, killerID)` payload — `killerID === deadPlayerID` means the player left voluntarily.
