//import {SessionController} from '../../SpectaclesSyncKit/Core/SessionController';
import { SessionController } from "SpectaclesSyncKit.lspkg/Core/SessionController";
import {StorageProperty} from "SpectaclesSyncKit.lspkg/Core/StorageProperty"
import {SyncEntity} from "SpectaclesSyncKit.lspkg/Core/SyncEntity"
import {SyncKitLogger} from "SpectaclesSyncKit.lspkg/Utils/SyncKitLogger"
import { PlayerVisuals } from './PlayerVisuals';

@component
export class Networker extends BaseScriptComponent {
    //to help debug — gated logging via this.log(); toggle in the Inspector
    @input
    showLogs: boolean = false;
    //connection id
    clientID: number;
    
    playerID: number; //equal to numbers of players (after self joined so p1 = 1, p2 = 2...)
    
    gridSyncEntity: SyncEntity;
    
    // Map to store individual cell storage properties
    private gridCells: Map<string, StorageProperty<vec2>> = new Map();
    
    // Map to store local cell state (for immediate reads before cloud sync)
    private localCellState: Map<string, vec2> = new Map();
    
    // Map to store cache timestamps for cleanup
    private localCacheTimestamps: Map<string, number> = new Map();
    
    private height = 40; //the length and width (in number of cells) of the grid cube
    
    private gridRadius = this.height / 2; //the radius is half of the diameter (the height & width of square)
    
    unitsPerCell: number = 200;//cells size in centimeters (also in gridclaimer which is getting phased out)
    
    private lastIdx = this.height * this.height; //last index in the grid (square of that is height tall and height wide)
    
    gridReady = false; //flag for grid being ready to use
    
    private firstClaim = true; //flag to create home claim on start
    
    private isPerformingBulkConversion = false; //flag to prevent multiple bulk conversions

    // NET-3/D3: monotonic counter bumped on death and at conversion-start. In-flight conversion
    // chains and the delayed 500ms stake write capture it and self-abort when it changes, so a
    // death (or a superseding conversion) invalidates work scheduled by a prior life/batch —
    // even across a respawn, where isAlive flips back to true.
    private conversionEpoch = 0;
    
    //player visuals script for minimap and world objects
    @input
    PlayerVisuals: PlayerVisuals;
    
    stakeList: vec2[] = []; //keep track of stake cells (in order)
    
    isAlive = true; //keep track of alive status of self

    private playerColorSlots: StorageProperty<vec2>[] = [];
    private pendingColorWrite: boolean = false;

    deathEventString = 'playerDeathEvent';

    // Event-driven minimap: track the current 5x5 window center and a dirty flag so the minimap
    // only redraws when the player crosses a cell boundary (window shifts) OR a cell inside the
    // window changes value (local write or remote cloud update) — instead of re-reading and
    // re-coloring 25 cells on every 0.1s tick.
    private miniMapCenterX = NaN; // NaN = uninitialized -> forces the first redraw once ready
    private miniMapCenterY = NaN;
    private miniMapDirty = false;
    
    //script to manager the grid claim modification permissions
    onAwake() {
        // Create new sync entity for this script
        this.gridSyncEntity = new SyncEntity(this);

        if (this.showLogs) {
            this.log("NetworkerV2: Sync entity created")
        }

        // Set up the sync entity notify on ready callback
        this.gridSyncEntity.notifyOnReady(() => {
            this.log("NetworkerV2: SyncEntity ready")
            this.gridReady = true;

            // Initialize all grid cells as individual storage properties
            this.initializeGridCells();
        });

        // All clients handle death cleanup, not just the dying player's device
        this.gridSyncEntity.onEventReceived.add(this.deathEventString, (messageInfo) => {
            const deathData = messageInfo.data as vec2;
            const deadPlayerID = deathData.x;
            const killerID = deathData.y;

            this.log("NetworkerV2: Death event — player " + deadPlayerID + " killed by " + killerID + " (self=" + this.clientID + ")");
            this.handlePlayerDeath(deadPlayerID);
        });

        // When a player leaves, treat it as death-by-self on all remaining clients
        SessionController.getInstance().onUserLeftSession.add((_session, userInfo) => {
            if (!userInfo.displayName) {
                this.log("NetworkerV2: Player left with null display name, skipping cleanup");
                return;
            }
            const leftClientID = this.computeClientID(userInfo.displayName);
            if (leftClientID === 0) {
                this.log("NetworkerV2: Leaving player hashes to clientID 0 (null-name collision), skipping cleanup");
                return;
            }
            this.log("NetworkerV2: Player left: " + userInfo.displayName + " (clientID=" + leftClientID + ")");
            this.handlePlayerDeath(leftClientID);
        });
    }
    
    // Initialize grid cells as individual storage properties
    private initializeGridCells() {
        if (this.showLogs) {
            this.log("NetworkerV2: Initializing grid cells as individual storage properties");
        }
        
        // Only initialize cells as needed (lazy initialization)
        // This avoids creating 1600 storage properties at once
        if (this.showLogs) {
            this.log("NetworkerV2: Grid cells will be initialized on-demand");
        }

        for (let i = 1; i <= 5; i++) {
            const slot = StorageProperty.manualVec2(`playerColorSlot_${i}`, vec2.zero());
            this.playerColorSlots.push(slot);
            this.gridSyncEntity.addStorageProperty(slot);
        }

        if (this.pendingColorWrite) {
            this.pendingColorWrite = false;
            this.assignAndWritePlayerID();
        }
    }
    
    // Get or create a cell storage property
    private getCellProperty(x: number, y: number): StorageProperty<vec2> | null {
        const key = this.getCellKey(x, y);
        
        // Check if property already exists
        if (this.gridCells.has(key)) {
            if (this.showLogs) this.log("NetworkerV2: CELL REUSE - Using existing property for cell (" + x + ", " + y + ")");
            return this.gridCells.get(key);
        }

        if (this.showLogs) this.log("NetworkerV2: CELL CREATE - Creating new property for cell (" + x + ", " + y + ")");
        
        // Create new storage property for this cell
        const cellProp = StorageProperty.manualVec2(key, vec2.zero());
        
        // Add to sync entity
        this.gridSyncEntity.addStorageProperty(cellProp);
        
        // Store in map
        this.gridCells.set(key, cellProp);
        
        // Add change listener for this cell
        cellProp.onAnyChange.add((newVal: vec2, oldVal: vec2) => {
            this.log("NetworkerV2: CELL CHANGE DETECTED - Cell (" + x + ", " + y + "):");
            
            // Handle potentially null values
            const oldClaimed = oldVal ? oldVal.x : 0;
            const oldStaked = oldVal ? oldVal.y : 0;
            const newClaimed = newVal ? newVal.x : 0;
            const newStaked = newVal ? newVal.y : 0;
            
            this.log("  OLD VALUE: claimed=" + oldClaimed + ", staked=" + oldStaked + " (was " + (oldVal ? "valid" : "null") + ")");
            this.log("  NEW VALUE: claimed=" + newClaimed + ", staked=" + newStaked + " (is " + (newVal ? "valid" : "null") + ")");
            
            // Cloud is now authoritative — always clear local cache on any cloud update.
            // Previously this only cleared when cloud value matched local cache (to detect
            // our own write confirmation). But if another player overwrites our pending write,
            // onAnyChange fires with THEIR value, which doesn't match ours, so the stale
            // local entry persisted and the minimap never updated for the overwritten player.
            const cellKey = this.getCellKey(x, y);
            if (this.localCellState.has(cellKey)) {
                this.localCellState.delete(cellKey);
                this.localCacheTimestamps.delete(cellKey);
                this.log("  🧹 LOCAL CACHE CLEARED - Cloud update received (cloud authoritative)");
            }
            
            // Special logging for stake-to-claim conversions (with null safety)
            if (oldStaked !== 0 && newStaked === 0 && newClaimed !== 0) {
                this.log("  ✓✓✓ STAKE SUCCESSFULLY CONVERTED TO CLAIM ✓✓✓");
            }

            // Event-driven minimap: a cloud update to a cell inside the current window dirties the
            // map so the next tick redraws it (covers REMOTE players' stakes/claims/conversions).
            if (this.isWithinMiniMapWindow(x, y)) {
                this.miniMapDirty = true;
            }
        });
        
        if (this.showLogs) this.log("NetworkerV2: Total cells in map: " + this.gridCells.size);
        
        return cellProp;
    }
    
    // Generate unique key for cell coordinates
    private getCellKey(x: number, y: number): string {
        return `cell_${x}_${y}`;
    }
    
    // Helper method to update both cloud storage and local state
    private updateCellValue(x: number, y: number, newValue: vec2, description: string = ""): boolean {
        const cellKey = this.getCellKey(x, y);
        const cellProp = this.getCellProperty(x, y);
        
        if (!cellProp) {
            this.log("NetworkerV2: ERROR - Could not update cell (" + x + ", " + y + ") - no property");
            return false;
        }
        
        // For critical operations like bulk conversions, use setValueImmediate when possible
        if (this.gridSyncEntity.canIModifyStore() && (description.includes("CONVERSION") || description.includes("INTERIOR"))) {
            this.log("NetworkerV2: CRITICAL OPERATION - Using setValueImmediate for " + description);
            cellProp.setValueImmediate(this.gridSyncEntity.currentStore, newValue);
            this.log("NetworkerV2: CLOUD IMMEDIATE - Cell (" + x + ", " + y + ") " + description + ": claimed=" + newValue.x + ", staked=" + newValue.y);
        } else {
            // Use setPendingValue for normal operations
            cellProp.setPendingValue(newValue);
            this.log("NetworkerV2: CLOUD PENDING - Cell (" + x + ", " + y + ") " + description + ": claimed=" + newValue.x + ", staked=" + newValue.y);
        }
        
        // ALSO update local state for immediate reads (ensures consistency until cloud sync)
        this.localCellState.set(cellKey, newValue);
        this.localCacheTimestamps.set(cellKey, Date.now()); // Track when we cached this
        this.log("NetworkerV2: LOCAL CACHED - Cell (" + x + ", " + y + ") for immediate reads");

        // Event-driven minimap: a LOCAL write to a cell inside the current window dirties the map
        // immediately, so our own stakes/claims/interior fills show without waiting for the cloud
        // round-trip (onAnyChange) to fire.
        if (this.isWithinMiniMapWindow(x, y)) {
            this.miniMapDirty = true;
        }

        return true;
    }
    
    setPlayerID(passedID: number): void {
        this.clientID = passedID;
        this.log("NetworkerV2: client ID set to: " + this.clientID);
        if (this.gridReady) {
            this.assignAndWritePlayerID();
        } else {
            this.pendingColorWrite = true;
        }
    }

    // Scans color slots to assign a stable playerID (1-5).
    // Rejoining players find their own slot and reuse it without writing.
    // New players claim the first empty slot, seeded by clientID to reduce simultaneous-join collisions.
    private assignAndWritePlayerID(): void {
        for (let i = 0; i < this.playerColorSlots.length; i++) {
            const val = this.playerColorSlots[i].currentValue;
            if (val && val.x === this.clientID) {
                this.playerID = val.y;
                this.log("NetworkerV2: Rejoining — reusing playerID=" + this.playerID + " from slot " + i);
                return;
            }
        }
        const startIdx = this.clientID % this.playerColorSlots.length;
        for (let offset = 0; offset < this.playerColorSlots.length; offset++) {
            const i = (startIdx + offset) % this.playerColorSlots.length;
            const val = this.playerColorSlots[i].currentValue;
            if (!val || val.x === 0) {
                this.playerID = i + 1;
                this.playerColorSlots[i].setPendingValue(new vec2(this.clientID, this.playerID));
                this.log("NetworkerV2: New player — claiming slot " + i + ", playerID=" + this.playerID);
                return;
            }
        }
        // NET-7: All 5 slots occupied (6+ players, none ours). Do NOT overwrite an active player's
        // slot — that corrupts their color mapping on every client. Instead take a shared fallback
        // color locally and skip the cloud write. getPlayerVisualID() derives the same
        // (clientID % 5) || 5 for any player with no slot, so remote coloring stays consistent.
        // Known tradeoff (accepted): this 6th+ player shares a color with an active player, and their
        // death can destroy the co-colored player's cubes on remote clients. No slot data is corrupted.
        this.playerID = (this.clientID % 5) || 5;
        this.log("NetworkerV2: All slots full — shared fallback color playerID=" + this.playerID + " (no slot write)");
    }

    getPlayerVisualID(clientID: number): number {
        if (clientID === this.clientID && this.playerID) return this.playerID;
        for (let i = 0; i < this.playerColorSlots.length; i++) {
            const val = this.playerColorSlots[i].currentValue;
            if (val && val.x === clientID) return val.y;
        }
        return (clientID % 5) || 5;
    }

    getCellDataReadOnly(x: number, y: number): vec2 {
        const key = `cell_${x}_${y}`;
        const cached = this.localCellState.get(key);
        if (cached) return cached;
        const prop = this.gridCells.get(key);
        if (prop) {
            const val = prop.currentValue;
            return (val && !isNaN(val.x)) ? val : vec2.zero();
        }
        return vec2.zero();
    }

    // True when (x, y) is inside the current 5x5 minimap window. Returns false until the window
    // has been established (center is NaN before the first getMiniMapCells snapshot).
    private isWithinMiniMapWindow(x: number, y: number): boolean {
        if (isNaN(this.miniMapCenterX)) return false;
        return Math.abs(x - this.miniMapCenterX) <= 2 && Math.abs(y - this.miniMapCenterY) <= 2;
    }

    // Center cell of the last-drawn 5x5 window (grid coords), or null before the first draw.
    // Lets the arrow's sub-cell offset wrap at the exact tick the window re-centers, so the
    // arrow stays glued to the map content instead of flicking a cell ahead of the redraw.
    getMiniMapWindowCenter(): vec2 | null {
        if (isNaN(this.miniMapCenterX)) return null;
        return new vec2(this.miniMapCenterX, this.miniMapCenterY);
    }

    // Cheap per-tick guard for LocationTracker: redraw only when the window has never been drawn,
    // the player crossed into a new cell (window shifts), or a windowed cell changed value.
    shouldRedrawMiniMap(centerX: number, centerY: number): boolean {
        return isNaN(this.miniMapCenterX)
            || centerX !== this.miniMapCenterX
            || centerY !== this.miniMapCenterY
            || this.miniMapDirty;
    }

    getMiniMapCells(centerX: number, centerY: number): (vec2 | null)[] {
        // Guard: only subscribe to cells once the SyncEntity is ready.
        // addStorageProperty must be called on a ready entity for silentSetCurrentValue
        // to load existing cloud values into currentValue. Properties subscribed before
        // ready stay at vec2.zero() permanently (not retroactively initialized).
        // Leaves the window center uninitialized so shouldRedrawMiniMap keeps returning true
        // (retrying every tick) until the grid is ready.
        if (!this.gridReady) return new Array(25).fill(vec2.zero());
        const result: (vec2 | null)[] = [];
        const radius = 2;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const gx = centerX + dx;
                const gy = centerY + dy;
                if (gx >= 0 && gx < this.height && gy >= 0 && gy < this.height) {
                    // getCellProperty registers a StorageProperty with the SyncEntity,
                    // which is required for remote updates to this cell to arrive.
                    const prop = this.getCellProperty(gx, gy);
                    const key = this.getCellKey(gx, gy);
                    const cached = this.localCellState.get(key);
                    const cacheAge = cached ? (Date.now() - (this.localCacheTimestamps.get(key) || 0)) : Infinity;
                    if (cached && cacheAge < 5000) {
                        result.push(cached);
                    } else if (prop) {
                        // Use currentValue: set by silentSetCurrentValue on addStorageProperty (initial
                        // store read) and by applyRemoteValue on all subsequent remote updates.
                        // currentOrPendingValue is NOT set by silentSetCurrentValue, so it stays
                        // vec2.zero() from the constructor and would always show unclaimed.
                        const val = prop.currentValue;
                        result.push((val && !isNaN(val.x)) ? val : vec2.zero());
                    } else {
                        result.push(vec2.zero());
                    }
                } else {
                    result.push(null);
                }
            }
        }
        // Record the window we just snapshotted and clear the dirty flag. Set at the END so any
        // onAnyChange that fired while subscribing new cells above is already captured in `result`;
        // the next redraw is then driven purely by a center change or a fresh windowed-cell change.
        this.miniMapCenterX = centerX;
        this.miniMapCenterY = centerY;
        this.miniMapDirty = false;
        return result;
    }

    
    //this function is called whenever self moves into a cell
    //function to update grid data (grid cell is vec2 representing claim and stake owner(s))
    sendData(ID: number, xpos: number, zpos: number, realWorldCoords: vec3) {
        //if player is dead, return early (they can't stake, claim, or kill)
        if (!this.isAlive){
            return;
        }
        
        // Block updates during bulk conversion to prevent race conditions
        if (this.isPerformingBulkConversion) {
            if (this.showLogs) {
                this.log("NetworkerV2: Skipping sendData during bulk conversion");
            }
            return;
        }
        
        if (!this.gridReady) {
            if (this.showLogs) {
                this.log("NetworkerV2: SEND - Grid not ready, cannot send");
            }
            return;
        }
        
        // Get the cell property for this position
        const cellProp = this.getCellProperty(xpos, zpos);
        if (!cellProp) {
            this.log("NetworkerV2: ERROR - Could not get/create cell property");
            return;
        }
        
        // Get current value of this specific cell (check local state first for immediate consistency).
        // Use currentValue (not currentOrPendingValue): silentSetCurrentValue (called by
        // addStorageProperty when the key already exists in the cloud) sets currentValue but
        // NOT currentOrPendingValue, so currentOrPendingValue would read vec2.zero() for any
        // cell that was staked/claimed before this client subscribed.
        const cellKey = this.getCellKey(xpos, zpos);
        const currentCellValue = this.localCellState.has(cellKey)
            ? this.localCellState.get(cellKey)
            : (cellProp.currentValue || vec2.zero());

        //special/base case of creating home claim on start
        if (this.firstClaim == true){
            this.log("NetworkerV2: SEND - creating home claim with cloud storage");
            //set first claim to false to not allow multiple home claims
            this.firstClaim = false;

            //home claim is claimed by self and staked by none
            const homeClaimVal = new vec2(ID, 0);

            // Use helper method to update both local state and cloud storage
            this.updateCellValue(xpos, zpos, homeClaimVal, "HOME CLAIM");

            //calculate the center of current cell for visuals
            const cellCenterCoords = this.gridPosToWorldCoords(xpos, zpos);
            //create visual for claim
            this.PlayerVisuals.createWorldClaimVolume(this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell);
            return;//can return early now that backend and frontend home claim tasks are handled
        }

        //use current data at current index to determine next step
        const claimedBy = currentCellValue.x;
        const stakedBy = currentCellValue.y;

        this.log("NetworkerV2: new cell is claimed by " + claimedBy + " and staked by " + stakedBy)

        //if staked by a player (will be 0 if not staked)
        if (stakedBy != 0){
            // Broadcast kill to all clients — the dead player's client will handle their own cleanup
            this.gridSyncEntity.sendEvent(this.deathEventString, new vec2(stakedBy, this.clientID));

            // If the stake belongs to a different player (not our own trail), stake the cell ourselves.
            // We don't call updateCellValue immediately here because the dead player's handlePlayerDeath
            // writes a cloud-clear (vec2(claimedBy, 0)) for all their staked cells. That clear travels
            // killer→network→dead client→network→cloud, so it arrives at the cloud server AFTER our
            // immediate setPendingValue and overwrites our stake.
            // Fix: write to localCellState and spawn the visual immediately (so the player sees it
            // and the minimap shows it), then delay the cloud write by 500ms so our write arrives
            // last and wins the race against the dead player's clear.
            if (stakedBy !== this.clientID) {
                const newCellValue = new vec2(claimedBy, ID);
                const cellCenterCoords = this.gridPosToWorldCoords(xpos, zpos);

                this.stakeList.push(new vec2(xpos, zpos));

                // Immediate local cache update — minimap reads this before cloud confirms
                this.localCellState.set(cellKey, newCellValue);
                this.localCacheTimestamps.set(cellKey, Date.now());

                // Spawn the world visual right away
                this.PlayerVisuals.createWorldStakeVolume(
                    this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell
                );

                // Delayed cloud write wins the race against the dead player's death-clear writes.
                // D3: capture the epoch now and only write if it's unchanged when the timer fires.
                // A conversion (we looped back to our claim) or our own death bumps the epoch, so a
                // stale write can't revert a just-converted claim back to a stake, nor write a stake
                // for a now-dead player. If neither happened, the epoch matches and the write proceeds.
                const writeEpoch = this.conversionEpoch;
                const delayedWrite = this.createEvent("DelayedCallbackEvent");
                delayedWrite.bind(() => {
                    if (this.conversionEpoch === writeEpoch) {
                        this.updateCellValue(xpos, zpos, newCellValue, "STAKE");
                    } else {
                        this.log("NetworkerV2: dropped stale delayed stake write at (" + xpos + ", " + zpos + ") — epoch changed");
                    }
                    this.removeEvent(delayedWrite); // one-shot: drop it so events don't accumulate unbounded
                });
                delayedWrite.reset(0.5); // 500ms — enough for death-clear to propagate
            }
        }
        //if claim is by self (ID param) claim any staked area
        else if (claimedBy == ID){
            //check for any staked region and convert stakes to claims
            this.addStakedRegionToClaim(realWorldCoords);
        }
        //if claim is not by self (or unclaimed), stake cell
        else {
            //stake any cell not claimed by self
            const newCellValue = new vec2(claimedBy, ID); // Keep claim, update stake

            this.stakeList.push(new vec2(xpos, zpos)); //add to stakeloop

            // Use helper method to update both local state and cloud storage
            this.updateCellValue(xpos, zpos, newCellValue, "STAKE");

            //create player visual for newly staked cell at center of cell and at current y
            const cellCenterCoords = this.gridPosToWorldCoords(xpos, zpos);
            this.PlayerVisuals.createWorldStakeVolume(this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell);
        }
        
        if (this.showLogs) {
            this.log("NetworkerV2: SEND - Successfully updated cell (" + xpos + ", " + zpos + ")");
        }
    }
    
    // function for accessing grid data
    getData(ID: number, xpos: number, zpos: number): vec2 {
        this.log("NetworkerV2: getData() called with ID=" + ID + ", xpos=" + xpos + ", zpos=" + zpos);
        
        // Always return a valid vec2, never undefined
        const fallbackVec = vec2.zero();
        
        try {
            if (!this.gridReady) {
                this.log("NetworkerV2: GET - Grid not ready, returning zero vec2");
                return fallbackVec;
            }
            
            this.log("NetworkerV2: GET REQUEST - Retrieving cell (" + xpos + ", " + zpos + ")");
            
            const cellKey = this.getCellKey(xpos, zpos);
            
            // FIRST: Check local state for immediate updates (handles race condition during bulk conversions)
            if (this.localCellState.has(cellKey)) {
                const cacheTimestamp = this.localCacheTimestamps.get(cellKey) || 0;
                const cacheAge = Date.now() - cacheTimestamp;
                
                // Use cache if it's fresh (less than 5 seconds old)
                if (cacheAge < 5000) {
                    const localValue = this.localCellState.get(cellKey);
                    this.log("NetworkerV2: ✅ GET LOCAL CACHE - Cell (" + xpos + ", " + zpos + "): claimed=" + localValue.x + ", staked=" + localValue.y + " (age: " + cacheAge + "ms)");
                    return localValue;
                } else {
                    // Cache is stale, remove it and fall through to cloud storage
                    this.log("NetworkerV2: 🗑️ STALE CACHE REMOVED - Cell (" + xpos + ", " + zpos + ") cache age: " + cacheAge + "ms");
                    this.localCellState.delete(cellKey);
                    this.localCacheTimestamps.delete(cellKey);
                }
            }
            
            const cellProp = this.getCellProperty(xpos, zpos);
            if (!cellProp) {
                this.log("NetworkerV2: ERROR - Could not get cell property, returning zero vec2");
                return fallbackVec;
            }

            let cellVec = cellProp.currentValue;
            if (!cellVec) {
                this.log("NetworkerV2: WARNING - Cell has no value, returning zero vec2");
                cellVec = fallbackVec;
            }
            
            // Ensure we have a valid vec2
            if (typeof cellVec.x === 'undefined' || typeof cellVec.y === 'undefined') {
                this.log("NetworkerV2: ERROR - Invalid vec2 structure, returning zero vec2");
                this.log("NetworkerV2: cellVec type: " + typeof cellVec + ", value: " + cellVec);
                return fallbackVec;
            }
            
            this.log("NetworkerV2: GET CLOUD - Cell (" + xpos + ", " + zpos + "): claimed=" + cellVec.x + ", staked=" + cellVec.y);
            
            // Log if this is a problematic stake that should have been converted
            if (cellVec.y === ID) {
                this.log("  ⚠️ WARNING: Cell is still staked by player " + ID + " - Cloud storage may not have persisted yet!");
            }
            
            this.log("NetworkerV2: Returning valid vec2: " + cellVec);
            return cellVec;
            
        } catch (error) {
            this.log("NetworkerV2: EXCEPTION in getData(): " + error);
            this.log("NetworkerV2: Returning fallback zero vec2");
            return fallbackVec;
        }
    }
    
    //returns index for gridata of the x and z coordinates of the grid (parameters)
    coordsToIndex(xCoord: number, zCoord: number): number {
        return this.height * zCoord + xCoord;
    }
    
    // Helper to convert index back to coordinates
    indexToCoords(index: number): vec2 {
        const z = Math.floor(index / this.height);
        const x = index % this.height;
        return new vec2(x, z);
    }
    
    // Converts grid position back to world coordinates (center of the cell)
    gridPosToWorldCoords(col: number, row: number): vec2 {
        const signedCol = col - this.gridRadius;
        const signedRow = row - this.gridRadius;
        const x = signedCol * this.unitsPerCell;
        const z = signedRow * this.unitsPerCell;
        return new vec2(x, z);
    }
    
    //function for handling player death — runs on ALL clients for both normal kills and player-leave events
    handlePlayerDeath(ID: number){
        this.log("NetworkerV2: Handling death of player " + ID);

        if (ID === this.clientID) {
            // Local-only: mark this device as dead and tear down its own tracking state
            this.isAlive = false;
            this.firstClaim = true;
            this.stakeList = [];
            // NET-3: invalidate any in-flight conversion/interior chain and pending delayed stake
            // write scheduled by this (now-dead) life, and clear the mutex so it can't linger while
            // dead (respawn() also clears it, but clearing here keeps it consistent on death alone).
            this.conversionEpoch++;
            this.isPerformingBulkConversion = false;
            this.localCellState.clear();
            this.localCacheTimestamps.clear();
            // spawnedClaims/spawnedStakes track only locally-spawned objects, so these are the right teardown paths
            this.PlayerVisuals.DestroyAllStakes();
            this.PlayerVisuals.DestroyAllClaims();
        } else {
            // Remote player died: destroy their visual objects on this device via Instantiator lookup
            if (this.gridReady) {
                this.PlayerVisuals.destroyPlayerVisuals(ID, this.getPlayerVisualID.bind(this));
            }
        }

        // All clients: zero dead player's cells in every subscribed cell property
        // (best-effort — only covers cells that have been getCellProperty'd on this device)
        if (this.gridReady) {
            for (const [key, cellProp] of this.gridCells) {
                const currentValue = cellProp.currentValue || vec2.zero();
                const claimClear = currentValue.x === ID;
                const stakeClear = currentValue.y === ID;
                if (claimClear || stakeClear) {
                    const newValue = new vec2(claimClear ? 0 : currentValue.x, stakeClear ? 0 : currentValue.y);
                    const keyParts = key.split('_');
                    if (keyParts.length === 3) {
                        const cellX = parseInt(keyParts[1]);
                        const cellY = parseInt(keyParts[2]);
                        this.updateCellValue(cellX, cellY, newValue, "DEATH CLEAR");
                    }
                }
            }
        }

        // All clients: free the dead player's color slot so a new player can claim it
        for (let i = 0; i < this.playerColorSlots.length; i++) {
            const val = this.playerColorSlots[i].currentValue;
            if (val && val.x === ID) {
                this.playerColorSlots[i].setPendingValue(vec2.zero());
                this.log("NetworkerV2: Freed color slot " + i + " for player " + ID);
                break;
            }
        }
    }

    // Re-enable a dead local player. Called by LocationTracker when the respawn
    // countdown completes. handlePlayerDeath already reset firstClaim/stakeList/caches
    // and destroyed our visuals, so we only need to flip alive back on, clear the
    // bulk-conversion mutex (in case we died mid-conversion), and re-establish our
    // cloud color slot (handlePlayerDeath freed it on all clients).
    respawn(): void {
        if (!this.gridReady) return;
        this.isAlive = true;
        this.firstClaim = true;              // re-arm home-claim creation
        this.stakeList = [];
        this.isPerformingBulkConversion = false;
        this.assignAndWritePlayerID();       // re-claim a color slot + set this.playerID
        this.log("NetworkerV2: Player " + this.clientID + " respawned");
    }

    // True when (x, y) is a valid grid cell [0, height). Same predicate used by getMiniMapCells.
    isInBounds(x: number, y: number): boolean {
        return x >= 0 && x < this.height && y >= 0 && y < this.height;
    }

    // Kill the LOCAL player (e.g. they walked out of the arena). Robust regardless of
    // whether sendEvent echoes to the local sender.
    killLocalPlayer(): void {
        if (!this.gridReady || !this.isAlive) return;
        // Tell every other client to destroy our visuals, clear our cells, and free our color slot.
        // onlySendRemote=true so the event does NOT loop back and double-run handlePlayerDeath locally.
        this.gridSyncEntity.sendEvent(this.deathEventString, new vec2(this.clientID, this.clientID), true);
        // Run our own teardown now (mirrors the onUserLeftSession path, which calls this directly).
        this.handlePlayerDeath(this.clientID);
        this.log("NetworkerV2: Player " + this.clientID + " died (left play area)");
    }

    //function for returning to claimed region and adding staked region to claim
    addStakedRegionToClaim(realWorldCoords: vec3){
        // Prevent multiple bulk conversions from happening simultaneously
        if (this.isPerformingBulkConversion) {
            this.log("NetworkerV2: Bulk conversion already in progress, skipping");
            return;
        }
        
        //if no stakes exist, return early
        const numOfStakes = this.stakeList.length;
        if (numOfStakes == 0){
            return;
        }
        
        this.isPerformingBulkConversion = true; // Set flag to prevent re-entry
        // NET-3/D3: mark a new batch. Bumping here cancels any still-pending delayed stake write
        // (D3) — every staked cell is in stakeList and thus in this conversion, so those writes
        // must not fire — and stamps this chain so a later death aborts it.
        this.conversionEpoch++;
        const epoch = this.conversionEpoch;
        this.log("NetworkerV2: BULK CONVERSION START - Converting " + numOfStakes + " stakes to claims with proper cloud storage");

        // Destroy stake visuals immediately
        this.PlayerVisuals.DestroyAllStakes();

        // Create copy of stakeList for processing
        const stakesToConvert = [...this.stakeList];

        // Clear the stake list early to prevent new stakes during conversion
        this.stakeList = [];
        this.log("NetworkerV2: stakeList cleared, length now: " + this.stakeList.length);

        // Start sequential conversion with proper cloud storage callbacks
        this.convertStakesSequentially(stakesToConvert, 0, realWorldCoords, epoch, () => {
            this.log("NetworkerV2: ✅ ALL STAKES SUCCESSFULLY CONVERTED TO CLOUD STORAGE!");

            // Find and fill enclosed region after successful conversion
            this.findAndFillEnclosedRegion(stakesToConvert, realWorldCoords, epoch);

            // Reset the conversion flag
            this.isPerformingBulkConversion = false;
            this.log("NetworkerV2: 🔄 Bulk conversion flag RESET - Normal operations resumed");
        });
    }
    
    // New method: Sequential stake conversion with proper cloud storage callbacks
    private convertStakesSequentially(stakes: vec2[], index: number, realWorldCoords: vec3, epoch: number, onComplete: () => void) {
        // NET-3: abort a stale chain (player died, or a newer batch superseded this one). Return
        // WITHOUT calling onComplete so a dead/superseded life never fills the interior.
        if (this.conversionEpoch !== epoch) {
            this.log("NetworkerV2: stake conversion chain aborted (epoch changed) at index " + index);
            return;
        }
        if (index >= stakes.length) {
            this.log("NetworkerV2: Sequential conversion completed for all " + stakes.length + " stakes");
            onComplete();
            return;
        }

        const stake = stakes[index];
        this.log("NetworkerV2: [" + (index + 1) + "/" + stakes.length + "] Converting stake at (" + stake.x + ", " + stake.y + ")");

        const cellProp = this.getCellProperty(stake.x, stake.y);
        if (!cellProp) {
            this.log("NetworkerV2: ERROR - Could not get cell property for stake conversion");
            // Continue with next stake
            this.convertStakesSequentially(stakes, index + 1, realWorldCoords, epoch, onComplete);
            return;
        }
        
        const cellKey = this.getCellKey(stake.x, stake.y);
        const currentValue = this.localCellState.get(cellKey) || cellProp.currentValue || vec2.zero();
        this.log("  BEFORE: claimed=" + currentValue.x + ", staked=" + currentValue.y);
        
        // Verify this cell is actually staked by us
        if (currentValue.y !== this.clientID) {
            this.log("  WARNING: Cell not staked by us! Staked by: " + currentValue.y + ", our ID: " + this.clientID);
        }
        
        // Convert stake to claim (set x to clientID, y to 0)
        const newValue = new vec2(this.clientID, 0);
        
        // Use helper method to ensure both local state and cloud storage are updated
        const success = this.updateCellValue(stake.x, stake.y, newValue, "STAKE→CLAIM CONVERSION");
        
        if (success) {
            this.log("  ✅ CONVERSION SUCCESS: Stake (" + stake.x + ", " + stake.y + ") → Claim");
            this.log("  AFTER: claimed=" + newValue.x + ", staked=" + newValue.y);
            
            //Create visual for newly claimed cell (exterior loop cell)
            const cellCenterCoords = this.gridPosToWorldCoords(stake.x, stake.y);
            //this.log("test first claim by id: " + this.playerID);
            this.PlayerVisuals.createWorldClaimVolume(this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell);
            
            // Add small delay to allow SpectaclesSyncKit to sync to cloud
            const delayedEvent = this.createEvent("DelayedCallbackEvent");
            delayedEvent.bind(() => {
                // Continue to next stake after delay (creates the next event before we drop this one)
                this.convertStakesSequentially(stakes, index + 1, realWorldCoords, epoch, onComplete);
                this.removeEvent(delayedEvent); // one-shot: bound live events to ~1 per active chain
            });
            delayedEvent.reset(0.04); // 40ms delay per conversion
        } else {
            this.log("  ❌ CONVERSION FAILED: Could not convert stake (" + stake.x + ", " + stake.y + ")");
            // Continue to next stake even on failure
            this.convertStakesSequentially(stakes, index + 1, realWorldCoords, epoch, onComplete);
        }
    }
    
    // Main function for filling the loop of cells.
    //
    // NET-4: enclosure on a discrete grid is a CONNECTIVITY problem, not a ray-cast/crossing-parity
    // one (the old point-in-polygon `isInLoop` treated cells as idealized points and missed squares
    // beside diagonal edges). Instead: build a barrier of cells the fill can't cross, flood the
    // EXTERIOR with a 4-connected BFS seeded outside the loop, and claim every in-bbox cell the flood
    // can't reach. This is the standard "flood the ocean, capture what it can't reach" technique.
    findAndFillEnclosedRegion(loop: vec2[], realWorldCoords: vec3, epoch: number) {
        // A loop needs at least a few cells to enclose anything.
        if (loop.length < 4) {
            return;
        }

        // Bounding box of the stake trail.
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const cell of loop) {
            minX = Math.min(minX, cell.x);
            maxX = Math.max(maxX, cell.x);
            minZ = Math.min(minZ, cell.y);
            maxZ = Math.max(maxZ, cell.y);
        }

        // A bbox that is a single cell wide/tall can't enclose anything.
        if (maxX - minX <= 1 || maxZ - minZ <= 1) {
            this.log("NetworkerV2: findAndFillEnclosedRegion: stake bounding box has no interior, returning early.");
            return;
        }

        // Cells are in [0, height); (x, z) -> unique integer key (no per-cell string allocation).
        const key = (x: number, z: number) => x * this.height + z;

        const barrier = new Set<number>();
        const addBarrier = (x: number, z: number) => {
            if (this.isInBounds(x, z)) {
                barrier.add(key(x, z));
            }
        };

        // (a) The trail itself, DENSIFIED with an integer (Bresenham) line between consecutive cells,
        // so a fast/diagonal step that crosses >1 cell in a single 0.1s tick can't leave a hole the
        // exterior flood leaks through. Added UNCONDITIONALLY (never gated on a cell read) so the seal
        // always holds. No last->first edge — the loop closes through owned territory (added in (b)).
        for (let i = 0; i < loop.length; i++) {
            addBarrier(loop[i].x, loop[i].y);
            if (i + 1 < loop.length) {
                const seg = this.bresenhamLine(loop[i], loop[i + 1]);
                for (const c of seg) {
                    addBarrier(c.x, c.y);
                }
            }
        }

        // (b) My existing claimed cells within the bbox. These seal the gap between the trail's first
        // and last cells through real territory (Paper.io: boundary = existing territory + new trail).
        // Enemy-owned cells (.x !== clientID) are intentionally NOT barriers, so an enemy cell trapped
        // inside the loop is unreachable by the flood -> captured and overwritten to me.
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                if (this.isInBounds(x, z) && this.getCellDataReadOnly(x, z).x === this.clientID) {
                    barrier.add(key(x, z));
                }
            }
        }

        // (c) 4-connected exterior flood over the bbox expanded by one cell (a guaranteed-outside
        // ring). 4-connectivity is REQUIRED so a diagonal (8-connected) barrier seals: the flood can't
        // slip through the corner-touch between two diagonally adjacent barrier cells. Out-of-grid
        // neighbors count as exterior, so loops hugging the arena edge fill correctly (the arena edge
        // is open, not a wall — consistent with out-of-bounds = death).
        const loX = minX - 1, hiX = maxX + 1;
        const loZ = minZ - 1, hiZ = maxZ + 1;
        const inRegion = (x: number, z: number) => x >= loX && x <= hiX && z >= loZ && z <= hiZ;

        const exterior = new Set<number>();
        const queue: vec2[] = [];
        const seed = (x: number, z: number) => {
            if (!inRegion(x, z) || !this.isInBounds(x, z)) return;
            const k = key(x, z);
            if (barrier.has(k) || exterior.has(k)) return;
            exterior.add(k);
            queue.push(new vec2(x, z));
        };

        // Seed every in-bounds, non-barrier cell that touches the region border or the grid edge
        // (i.e. has an out-of-region or out-of-grid 4-neighbor) — those are guaranteed exterior.
        for (let x = loX; x <= hiX; x++) {
            for (let z = loZ; z <= hiZ; z++) {
                if (!this.isInBounds(x, z)) continue;
                const onRegionBorder = x === loX || x === hiX || z === loZ || z === hiZ;
                const touchesGridEdge = !this.isInBounds(x + 1, z) || !this.isInBounds(x - 1, z)
                                     || !this.isInBounds(x, z + 1) || !this.isInBounds(x, z - 1);
                if (onRegionBorder || touchesGridEdge) {
                    seed(x, z);
                }
            }
        }

        // BFS: 4-connected, staying within the region, never crossing a barrier.
        let head = 0;
        while (head < queue.length) {
            const cur = queue[head++];
            seed(cur.x + 1, cur.y);
            seed(cur.x - 1, cur.y);
            seed(cur.x, cur.y + 1);
            seed(cur.x, cur.y - 1);
        }

        // (d) Interior = in-bounds bbox cells that are neither barrier nor exterior. Iterate the FULL
        // bbox: in concave loops a non-trail cell on the bbox border can be interior, and the flood
        // has already marked it exterior if it was actually reachable from outside.
        const interiorCells: vec2[] = [];
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                if (!this.isInBounds(x, z)) continue;
                const k = key(x, z);
                if (!barrier.has(k) && !exterior.has(k)) {
                    interiorCells.push(new vec2(x, z));
                }
            }
        }

        if (interiorCells.length === 0) {
            this.log("NetworkerV2: No interior cells found to claim");
            return;
        }

        this.log("NetworkerV2: Found " + interiorCells.length + " interior cells to claim with cloud storage");

        // Convert interior cells using cloud storage (unchanged async chain + epoch abort guard).
        this.claimInteriorCellsSequentially(interiorCells, 0, realWorldCoords, epoch, () => {
            this.log("NetworkerV2: ✅ All interior cells successfully claimed in cloud storage!");
            this.log("NetworkerV2: Flood-fill region fill complete!");
        });
    }
    
    // New method: Sequential interior cell claiming with proper cloud storage callbacks
    private claimInteriorCellsSequentially(cells: vec2[], index: number, realWorldCoords: vec3, epoch: number, onComplete: () => void) {
        // NET-3: abort a stale chain (player died, or a newer batch superseded this one).
        if (this.conversionEpoch !== epoch) {
            this.log("NetworkerV2: interior claim chain aborted (epoch changed) at index " + index);
            return;
        }
        if (index >= cells.length) {
            this.log("NetworkerV2: Sequential interior claiming completed for all " + cells.length + " cells");
            onComplete();
            return;
        }

        const cell = cells[index];
        this.log("NetworkerV2: [" + (index + 1) + "/" + cells.length + "] Claiming interior cell at (" + cell.x + ", " + cell.y + ")");

        const cellProp = this.getCellProperty(cell.x, cell.y);
        if (!cellProp) {
            this.log("NetworkerV2: ERROR - Could not get cell property for interior cell");
            // Continue with next cell
            this.claimInteriorCellsSequentially(cells, index + 1, realWorldCoords, epoch, onComplete);
            return;
        }
        
        // Claim this interior cell
        const newValue = new vec2(this.clientID, 0);
        
        // Use helper method to ensure both local state and cloud storage are updated
        const success = this.updateCellValue(cell.x, cell.y, newValue, "INTERIOR CLAIM");
        
        if (success) {
            this.log("  ✅ INTERIOR CELL CLAIMED: (" + cell.x + ", " + cell.y + ") updated");
            
            // Create visual for newly claimed cell
            const cellCenterCoords = this.gridPosToWorldCoords(cell.x, cell.y);
            //this.log("test first claim by id: " + this.playerID);
            this.PlayerVisuals.createWorldClaimVolume(this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell);
            
            // Add small delay to allow SpectaclesSyncKit to sync to cloud
            const delayedEvent = this.createEvent("DelayedCallbackEvent");
            delayedEvent.bind(() => {
                // Continue to next cell after delay (creates the next event before we drop this one)
                this.claimInteriorCellsSequentially(cells, index + 1, realWorldCoords, epoch, onComplete);
                this.removeEvent(delayedEvent); // one-shot: bound live events to ~1 per active chain
            });
            delayedEvent.reset(0.05); // 50ms delay per claim
        } else {
            this.log("  ❌ INTERIOR CLAIM FAILED: Could not claim cell (" + cell.x + ", " + cell.y + ")");
            // Continue to next cell even on failure
            this.claimInteriorCellsSequentially(cells, index + 1, realWorldCoords, epoch, onComplete);
        }
    }
    
    // Integer (Bresenham) line between two grid cells, both endpoints inclusive. Used to densify the
    // stake trail so a fast/diagonal step that skips cells still forms a connected barrier for the
    // flood fill in findAndFillEnclosedRegion. A no-op (returns just the endpoints) for adjacent cells.
    private bresenhamLine(a: vec2, b: vec2): vec2[] {
        const points: vec2[] = [];
        let x0 = Math.round(a.x), y0 = Math.round(a.y);
        const x1 = Math.round(b.x), y1 = Math.round(b.y);
        const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        while (true) {
            points.push(new vec2(x0, y0));
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x0 += sx; }
            if (e2 < dx) { err += dx; y0 += sy; }
        }
        return points;
    }

    // FNV-1a hash matching LocationTracker.getDeterministicPlayerId —
    // used to recover the clientID of a leaving player from their display name
    private computeClientID(displayName: string): number {
        if (!displayName) return 0;
        let hash = 0x811c9dc5;
        for (let i = 0; i < displayName.length; i++) {
            hash ^= displayName.charCodeAt(i);
            hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        }
        return (hash >>> 0) % 0xFFFFFF;
    }

    //gated logging: only prints when showLogs is enabled
    private log(msg: string): void {
        if (this.showLogs) {
            print(msg);
        }
    }
}