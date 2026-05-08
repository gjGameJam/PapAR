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
4. Calls `Networker.getData(clientID, gridPos.x, gridPos.y)` every tick — result is used only for debug logging (`print("cell: " + gridPos + " is claimed by: " + claimedBy + ...)`), not for game logic
5. Only calls `Networker.sendData()` if the player has moved to a **new cell** (checked by `PlayerVisuals.isInSameCell()`)

Note: `sendData()` performs its own independent read of the cell state — it does **not** use the return value from the `getData()` call above.

**Player ID assignment**: On `SessionController.notifyOnReady()`, the local Snapchat display name is hashed via `getDeterministicPlayerId()` (FNV-1a) to produce `clientID`. `Networker.setPlayerID(clientID, sessionController.getUsers().length)` is called at this point — `playerNumber` is the count of users currently in the session.

**Rotation**: `getDeviceTrackerRotation()` extracts yaw from the device quaternion using the standard formula and normalizes to `[0, 2π]`. This is called from `PlayerVisuals.onUpdate()` every frame.

**Key `@input` fields**: `playerTracker: DeviceTracking`, `Networker`, `networkedInstantiator: Instantiator`, `PlayerVisuals`

---

### `Networker.ts` — All game state and logic

This is the authoritative game logic script. It owns the entire cloud grid, manages the Paper.io rule set, drives stake/claim conversion, and handles death.

#### Initialization sequence

`onAwake()` creates `gridSyncEntity = new SyncEntity(this)`. When the entity is ready (`notifyOnReady`), `gridReady = true` and `initializeGridCells()` is called — which in the current implementation does nothing (a no-op comment); all cell properties are created lazily on first access. The death RPC listener is also registered in `onAwake()` unconditionally (before `gridReady`).

#### Player ID fields

- `clientID: number` — the FNV-1a hash of the Snapchat username (unique per player, persists across sessions)
- `playerID: number` — visual color set index `1–5` (recycled from `clientID % 5 || 5`); used only for prefab selection

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

Death is broadcast via RPC, not `StorageProperty`, for immediacy:

```
gridSyncEntity.sendEvent('playerDeathEvent', vec2(deadPlayerID, killerID))
```

All clients receive this. The listener in `onAwake()` checks `if (deadPlayerID === clientID)` before calling `handlePlayerDeath()`.

`handlePlayerDeath(ID)`:
1. Sets `isAlive = false`, `firstClaim = true`, clears `stakeList`
2. Iterates all `gridCells` entries — zeroes `x` if claimed by the dead player, zeroes `y` if staked by them
3. Clears `localCellState` and `localCacheTimestamps` entirely (not just dead player's cells)
4. Calls `PlayerVisuals.DestroyAllStakes()` and `PlayerVisuals.DestroyAllClaims()`

Note: after death, `isAlive = false` prevents `sendData()` from doing anything. There is currently no respawn mechanic — the player is permanently dead until the lens is restarted.

#### Cloud storage & local cache

**Lazy property creation** via `getCellProperty(x, y)`: checks `gridCells` Map first; if missing, creates `StorageProperty.manualVec2("cell_x_y", vec2.zero())`, adds it to `gridSyncEntity`, attaches an `onAnyChange` listener, stores in the map.

**`updateCellValue(x, y, newValue, description)`**: the single write path. Always:
1. Uses `setValueImmediate()` if description contains `"CONVERSION"` or `"INTERIOR"` and `canIModifyStore()` is true; otherwise uses `setPendingValue()`
2. Always writes to `localCellState` map with current timestamp

**`getData(ID, x, y)`**: read path. The `ID` parameter is accepted but **never used** inside the function body — it exists in the signature as a legacy artifact. Checks `localCellState` first (uses if cache age < **5000ms**); falls back to `cellProp.currentOrPendingValue`; returns `vec2.zero()` on any error. Note: `sendData()` does NOT call `getData()` — it reads cell state directly from `localCellState`/`currentOrPendingValue` internally.

**`onAnyChange` listener**: When cloud confirms a write, if the cached local value matches the new cloud value, the local cache entry is deleted (cloud is now authoritative).

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

**All spawning** goes through `networkedInstantiator.instantiate()` from SpectaclesSyncKit's `Instantiator`, so every spawned object appears on all connected clients automatically.

> **Known Bug — Visual objects do not appear for remote players.** See the [Frontend Networking Bug](#frontend-networking-bug) section for full diagnosis and the required fixes before reading the spawning details below.

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

**Destruction**: `DestroyAllClaims()` and `DestroyAllStakes()` iterate their arrays, call `obj.destroy()` on each, then reset array length to 0.

#### 5×5 minimap

`updateMiniMap(gridPos, grid)` is called from `GridClaimer.updatePos()` (legacy path). It renders a `±2` cell window around the player onto a pre-wired `Image[]` array (`miniMapCells`). The array is row-major: index = `gridY * 5 + gridX`.

Colors:
- `UNCLAIMED` → `vec4(0, 0, 255, 0.5)` blue
- `STAKED` → `vec4(255, 255, 0, 0.5)` yellow
- `CLAIMED` → `vec4(0, 255, 0, 0.5)` green
- `null` (out of bounds) → `vec4(255, 0, 0, 0.5)` red

Material cloning: each `Image` in `miniMapCells` gets its material cloned on the first write (guarded by `img.__hasUniqueMaterial`) to prevent shared-material color bleed across all cells.

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

`recyclePlayerNumsForVisuals(playerNumber)`:
```typescript
return (playerNumber % 5) || 5  // returns 1–5, never 0
```
`playerNumber` is `sessionController.getUsers().length` at the moment the player joins. This means the nth player to join gets color set n (mod 5). Color sets are reused after 5 players, so player 6 shares visuals with player 1. `playerID` is only used for prefab selection — it is never stored in the cloud grid.

---

## Networking Architecture (SpectaclesSyncKit)

### SyncEntity

One `SyncEntity` (`gridSyncEntity`) is created on the `Networker` component. All `StorageProperty` instances are added to this entity. The entity manages cloud store access (`canIModifyStore()`, `currentStore`) and event routing.

### Storage properties

`StorageProperty.manualVec2(key, defaultValue)` creates a named, typed cloud property. Adding it to the sync entity registers it for cloud synchronization. Once added, the property is never removed — it persists for the session.

**Maximum theoretical cells**: 40×40 = 1,600. In practice only visited cells get properties.

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
        ├─▶ PlayerVisuals.updateHUDText()         [every tick]
        │
        ├─▶ Networker.getData()                   [every tick, debug logging only]
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

## Frontend Networking Bug

**Status: Unresolved as of the last commit on this branch.**

The backend grid state (StorageProperty, death RPCs) syncs correctly across clients. Visual objects — claim cubes, stake cubes, stake pillars — appear correctly for the local (spawning) player but are invisible to all other players. Three bugs are in play.

---

### Bug 1 — Transform is never encoded in the spawn store (affects all 15 prefabs)

`createWorldClaimVolume` and `createWorldStakeVolume` in `PlayerVisuals.ts` call:

```typescript
this.networkedInstantiator.instantiate(prefab, undefined, (networkRoot) => {
    networkRoot.sceneObject.getTransform().setLocalPosition(newPosition);
    networkRoot.sceneObject.getTransform().setLocalScale(scaleVec);
    this.spawnedClaims.push(networkRoot.sceneObject);
});
```

The `onSuccess` callback **only fires on the spawning client.** Inside the Instantiator source (`Instantiator.ts`), the spawning path calls `session.createRealtimeStore(...)`, and the callback is invoked inside that store-creation closure — on the local machine only. Remote clients reconstruct objects through `instantiatePrefabFromStore()`, a completely separate code path with no callback:

```typescript
// Instantiator.ts — remote client reconstruction path
if (store.has("_init_pos"))   rootObj.getTransform().setLocalPosition(store.getVec3("_init_pos"))
if (store.has("_init_scale")) rootObj.getTransform().setLocalScale(store.getVec3("_init_scale"))
```

The store only contains `_init_pos` / `_init_scale` when `localPosition` / `localScale` (or their world equivalents) are passed in `InstantiationOptions`. Because `undefined` is passed as options, those keys are never written. Remote clients spawn every object at world origin `(0, 0, 0)` with scale `(1, 1, 1)` — a 1 cm cube, effectively invisible in AR.

**The fix** is to move transform data into `InstantiationOptions` and only use the callback for bookkeeping:

```typescript
// createWorldClaimVolume — corrected
createWorldClaimVolume(ID: number, x: number, y: number, z: number, scale: number) {
    if (!this.networkedInstantiator.isReady()) return;
    const newPosition = new vec3(x, y - (scale / 6), z);
    this.networkedInstantiator.instantiate(
        this.getClaimVolumeFromPlayerID(ID),
        { localPosition: newPosition, localScale: new vec3(scale, scale, scale) },
        (networkRoot) => {
            this.spawnedClaims.push(networkRoot.sceneObject);
        }
    );
}

// createWorldStakeVolume — corrected
createWorldStakeVolume(ID: number, x: number, y: number, z: number, scale: number) {
    if (!this.networkedInstantiator.isReady()) return;
    const newPosition = new vec3(x, y - (scale / 6), z);
    this.networkedInstantiator.instantiate(
        this.getStakeVolumeFromPlayerID(ID),
        { localPosition: newPosition, localScale: new vec3(scale, scale, scale) },
        (networkRoot) => { this.spawnedStakes.push(networkRoot.sceneObject); }
    );
    this.networkedInstantiator.instantiate(
        this.getStakePillarFromPlayerID(ID),
        { localPosition: newPosition, localScale: new vec3(1, scale, 1) },
        (networkRoot) => { this.spawnedStakes.push(networkRoot.sceneObject); }
    );
}
```

When `localPosition` / `localScale` are provided, the Instantiator writes them into the `GeneralDataStore` before broadcasting the spawn to other clients. Every client — including latecomers who join after the object was placed — reads those keys from the store and applies the correct transform at instantiation time.

---

### Bug 2 — Instantiator not placing spawned objects under `ColocatedWorld` (scene configuration)

The `networkedInstantiator` component (`d6452a32`) that `PlayerVisuals.ts` uses has two misconfigured fields in the Lens Studio scene:

```yaml
spawnAsChildren: false          # should be true
spawnUnderParent: 00000000...   # null — should reference ColocatedWorld [CONFIGURE_ME]
```

Because `spawnAsChildren` is false and `spawnUnderParent` is null, every instantiated object spawns at **scene root** with no parent. This matters because:

1. `ColocatedWorld [CONFIGURE_ME]` has a `LocatedAtComponent` directly on it. If spawned objects were children of that node, SyncTransform "Location" mode would work correctly — `findLocatedAtComponent()` would find it by walking up the hierarchy.
2. At scene root, there is no `LocatedAtComponent` ancestor. Any SyncTransform in "Location" mode on a spawned prefab therefore throws an error and silently fails.

**The fix** is in the Lens Studio Inspector on the `networkedInstantiator` component:
- Set `spawnAsChildren` → `true`
- Set `spawnUnderParent` → drag `ColocatedWorld [CONFIGURE_ME]` into the field

---

### Bug 3 — `SyncTransform` with `"Location"` mode fails on `P1ClaimCube.prefab`

`P1ClaimCube.prefab` (confirmed from the prefab file) has a `SyncTransform` component with all three axes set to `"Location"` mode. The other 14 prefabs currently do **not** have SyncTransform.

`"Location"` mode resolves transforms relative to a `LocatedAtComponent` ancestor in the scene hierarchy via `findLocatedAtComponent()` in `StorageProperty.ts`:

```typescript
function findLocatedAtComponent(object: SceneObject): LocatedAtComponent {
    for (const component of object.getComponents("Component.LocatedAtComponent")) {
        return component
    }
    return findLocatedAtComponent(object.getParent())  // walks up
}
```

Because of Bug 2, the spawned P1ClaimCube goes to scene root — no `LocatedAtComponent` ancestor exists. `getLocationTransform()` throws an error during SyncTransform initialization, silently preventing any transform sync.

**Fix options (choose one):**
- **Preferred:** Fix Bug 2 (set `spawnUnderParent → ColocatedWorld`). Location mode will then work correctly since `ColocatedWorld` has the `LocatedAtComponent`.
- **Alternative:** Change SyncTransform mode on `P1ClaimCube.prefab` from `"Location"` to `"Local"` or `"World"`. Neither mode requires a `LocatedAtComponent`.
- Regardless of which fix is chosen, Bug 1 (`InstantiationOptions`) must also be fixed — otherwise remote clients still spawn at the wrong position since SyncTransform only corrects ongoing changes, not the initial spawn state.

> **Scope note:** If the intent is to add SyncTransform to all 15 prefabs (currently only on P1ClaimCube), fix Bug 2 first so Location mode works, then add SyncTransform to the remaining 14 prefabs.

---

### Bug 4 — `SyncMaterials` on `P1ClaimCube.prefab` (confirmed, behavior unclear)

`P1ClaimCube.prefab` also has a `SyncMaterials` component (the same prefab that has SyncTransform). It is configured to sync the `baseColor` property of the claim material, with `autoClone: false`:

```yaml
Name: SyncMaterials
mainMaterial: f16c896d...   # P1ClaimTransparentMat
propertyNames: [baseColor]
autoClone: false
```

`autoClone: false` means the material is NOT cloned per instance — all spawned P1 claim cubes share the same material object. Any network-driven change to `baseColor` would affect all of them simultaneously. Since the claim color is already baked into the P1 shader and doesn't change at runtime, this component is likely not doing useful work. Its behavior on dynamically instantiated objects (vs. static scene objects it was designed for) is unverified.

If SyncMaterials experiences the same `LocatedAtComponent` requirement as SyncTransform in Location mode, it will fail for the same reason as Bug 3. Verify in the Lens Studio inspector whether SyncMaterials uses a location-based sync mode.

---

### Why the backend works but the frontend does not

The cloud grid state (`StorageProperty<vec2>` per cell in `Networker.ts`) is entirely separate from the visual objects. It uses `gridSyncEntity`, which is created on a persistent scene object that exists from session start and has no dependency on `LocatedAtComponent` or Instantiator hierarchy. The Instantiator's `_init_pos` / `_init_scale` mechanism and `SyncTransform` are specific to dynamically spawned objects. The two systems are completely independent, which is why grid data syncs correctly while visuals do not.

---

### What other players actually see

Because Bug 1 leaves `_init_pos` / `_init_scale` out of the store, and Bug 3 prevents SyncTransform from correcting the P1ClaimCube transform (with all other prefabs having no SyncTransform at all), remote clients receive every spawned object at `vec3(0, 0, 0)` with scale `vec3(1, 1, 1)`. A 1 cm cube at the AR world origin is invisible in practice — especially since the world origin is only ever at that exact point during colocated session setup and players are almost never standing there. The backend print statements confirming grid updates are accurate; the visual layer is entirely broken for everyone except the spawning player.

---

### Scene configuration reference

Key settings confirmed from `Scene.scene` for the components involved:

**`networkedInstantiator` (`d6452a32`, on `PlayerVisuals` scene object)**:
- `prefabs[]`: all 15 game prefabs registered ✓
- `spawnerOwnsObject: false` ✓
- `spawnAsChildren: false` ← **Bug 2 — should be true**
- `spawnUnderParent: 00000000...` ← **Bug 2 — should be ColocatedWorld [CONFIGURE_ME]**
- `autoInstantiate: false` ✓
- `persistenceString: Session` ✓

**`SessionController [CONFIGURE_ME]` scene object** (named with `[CONFIGURE_ME]` but fully configured):
- `connectedLensModule` ✓
- `locationCloudStorageModule` ✓
- `isColocated: true` ✓
- `locatedAtComponent` → `ColocatedWorld [CONFIGURE_ME]`'s LocatedAtComponent ✓
- `skipUiInStudio: false` — the multiplayer joining UI shows even in Studio (default was `true`; change to `true` for faster Studio iteration)

**`ColocatedWorld [CONFIGURE_ME]` scene object**:
- Has `LocatedAtComponent` (`c975066f`) directly on it ✓
- Is the correct `spawnUnderParent` target for the Instantiator fix

The scene also contains several leftover example objects from the SpectaclesSyncKit template that are not used by game logic: `SessionControllerExampleTypescript`, two `SessionControllerExampleJavascript` objects, `InstantiatorExampleAuto`, a `SyncTransform` demo scene object, and a `SyncMaterial` demo scene object (disabled). These can be deleted to reduce scene clutter.

---

## Known Incomplete Areas

- **Respawn**: After `handlePlayerDeath()`, `isAlive = false` and nothing sets it back to `true`. Players cannot move after dying without restarting the lens.
- **Multiplayer kill by territory**: The `sendData()` logic only kills the owner of a stake trail. Entering an enemy's claimed cell does not kill the entering player (no logic for that case in the current else-branch — it just stakes the cell over the enemy claim).
- **ClientID race condition**: `SessionController.notifyOnReady()` and `networkedInstantiator.notifyOnReady()` are independent callbacks in `LocationTracker.onAwake()`. If the instantiator fires first, the position loop starts with `clientID = undefined`, and the first few `sendData()` calls pass `undefined` as the player ID.
- **`getData()` unused ID parameter**: `getData(ID, xpos, zpos)` accepts an `ID` parameter that is never referenced inside the function body. Calls to `getData()` in `LocationTracker` pass `clientID` but it has no effect.
- **`GridClaimer` minimap**: `updateMiniMap()` reads from a local `SparseGrid` (not the cloud). When using `Networker` for game logic, the minimap data will be stale/empty unless someone also maintains the local grid.
- **`UnionFindLoopDetection.ts`**: Entirely commented out. The `LoopDetection` class compiles as an empty component. The Union-Find approach it implements would have been more correct for detecting loop closure mid-trail (before the player returns to home territory), but was replaced by the simpler ray-cast fill which only runs after the return.
- **Player count cap**: `recyclePlayerNumsForVisuals` cycles colors across players 6+. No hard cap on player count exists in code, but the SessionController and SpectaclesSyncKit may impose their own limits.
- **Interior fill correctness**: The ray-casting algorithm works correctly for simple convex and concave polygons, but diagonal stake trails can produce ambiguous edge cases since cells are discrete units while the algorithm treats them as point coordinates.
