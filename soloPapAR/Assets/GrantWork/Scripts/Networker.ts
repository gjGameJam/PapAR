//import {SessionController} from '../../SpectaclesSyncKit/Core/SessionController';
import { SessionController } from "SpectaclesSyncKit.lspkg/Core/SessionController";
import {StorageProperty} from "SpectaclesSyncKit.lspkg/Core/StorageProperty"
import {SyncEntity} from "SpectaclesSyncKit.lspkg/Core/SyncEntity"
import {SyncKitLogger} from "SpectaclesSyncKit.lspkg/Utils/SyncKitLogger"
import { PlayerVisuals } from './PlayerVisuals';

@component
export class Networker extends BaseScriptComponent {
    //to help debug
    showLogs: boolean = true;
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
    
    private gridReady = false; //flag for grid being ready to use
    
    private firstClaim = true; //flag to create home claim on start
    
    private isPerformingBulkConversion = false; //flag to prevent multiple bulk conversions
    
    //player visuals script for minimap and world objects
    @input
    PlayerVisuals: PlayerVisuals;
    
    stakeList: vec2[] = []; //keep track of stake cells (in order)
    
    isAlive = true; //keep track of alive status of self

    private playerColorSlots: StorageProperty<vec2>[] = [];
    private pendingColorWrite: boolean = false;

    deathEventString = 'playerDeathEvent';
    
    //script to manager the grid claim modification permissions
    onAwake() {
        // Create new sync entity for this script
        this.gridSyncEntity = new SyncEntity(this);
        
        if (this.showLogs) {
            print("NetworkerV2: Sync entity created")
        }
        
        // Set up the sync entity notify on ready callback
        this.gridSyncEntity.notifyOnReady(() => {
            print("NetworkerV2: SyncEntity ready")
            this.gridReady = true;
            
            // Initialize all grid cells as individual storage properties
            this.initializeGridCells();
        });
        
        
        // register for death events
        this.gridSyncEntity.onEventReceived.add(this.deathEventString, (messageInfo) => {
            const deathData = messageInfo.data as vec2;
            const deadPlayerID = deathData.x;
            const killerID = deathData.y;
            
            print("NetworkerV2: player " + deadPlayerID + " killed player " + killerID + " self is " + this.clientID);
            
            // Only handle death if we're the one who died
            if (deadPlayerID === this.clientID) {
                this.handlePlayerDeath(deadPlayerID);
            }
        });
    }
    
    // Initialize grid cells as individual storage properties
    private initializeGridCells() {
        if (this.showLogs) {
            print("NetworkerV2: Initializing grid cells as individual storage properties");
        }
        
        // Only initialize cells as needed (lazy initialization)
        // This avoids creating 1600 storage properties at once
        if (this.showLogs) {
            print("NetworkerV2: Grid cells will be initialized on-demand");
        }

        for (let i = 1; i <= 5; i++) {
            const slot = StorageProperty.manualVec2(`playerColorSlot_${i}`, vec2.zero());
            this.playerColorSlots.push(slot);
            this.gridSyncEntity.addStorageProperty(slot);
        }

        if (this.pendingColorWrite) {
            this.pendingColorWrite = false;
            this.writePlayerColorMapping();
        }
    }
    
    // Get or create a cell storage property
    private getCellProperty(x: number, y: number): StorageProperty<vec2> | null {
        const key = this.getCellKey(x, y);
        
        // Check if property already exists
        if (this.gridCells.has(key)) {
            if (this.showLogs) print("NetworkerV2: CELL REUSE - Using existing property for cell (" + x + ", " + y + ")");
            return this.gridCells.get(key);
        }

        if (this.showLogs) print("NetworkerV2: CELL CREATE - Creating new property for cell (" + x + ", " + y + ")");
        
        // Create new storage property for this cell
        const cellProp = StorageProperty.manualVec2(key, vec2.zero());
        
        // Add to sync entity
        this.gridSyncEntity.addStorageProperty(cellProp);
        
        // Store in map
        this.gridCells.set(key, cellProp);
        
        // Add change listener for this cell
        cellProp.onAnyChange.add((newVal: vec2, oldVal: vec2) => {
            print("NetworkerV2: CELL CHANGE DETECTED - Cell (" + x + ", " + y + "):");
            
            // Handle potentially null values
            const oldClaimed = oldVal ? oldVal.x : 0;
            const oldStaked = oldVal ? oldVal.y : 0;
            const newClaimed = newVal ? newVal.x : 0;
            const newStaked = newVal ? newVal.y : 0;
            
            print("  OLD VALUE: claimed=" + oldClaimed + ", staked=" + oldStaked + " (was " + (oldVal ? "valid" : "null") + ")");
            print("  NEW VALUE: claimed=" + newClaimed + ", staked=" + newStaked + " (is " + (newVal ? "valid" : "null") + ")");
            
            // Clean up local cache when cloud storage updates (cloud is now authoritative)
            const cellKey = this.getCellKey(x, y);
            if (this.localCellState.has(cellKey)) {
                const localValue = this.localCellState.get(cellKey);
                // Only clear cache if cloud value matches our local cache (cloud confirmed)
                // AND it's not a conversion scenario where cloud might be lagging
                if (localValue.x === newClaimed && localValue.y === newStaked) {
                    this.localCellState.delete(cellKey);
                    this.localCacheTimestamps.delete(cellKey);
                    print("  🧹 LOCAL CACHE CLEARED - Cloud storage confirmed update");
                } else {
                    print("  ⏳ LOCAL CACHE KEPT - Cloud (" + newClaimed + "," + newStaked + ") != Local (" + localValue.x + "," + localValue.y + ")");
                }
            }
            
            // Special logging for stake-to-claim conversions (with null safety)
            if (oldStaked !== 0 && newStaked === 0 && newClaimed !== 0) {
                print("  ✓✓✓ STAKE SUCCESSFULLY CONVERTED TO CLAIM ✓✓✓");
            }
        });
        
        if (this.showLogs) print("NetworkerV2: Total cells in map: " + this.gridCells.size);
        
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
            print("NetworkerV2: ERROR - Could not update cell (" + x + ", " + y + ") - no property");
            return false;
        }
        
        // For critical operations like bulk conversions, use setValueImmediate when possible
        if (this.gridSyncEntity.canIModifyStore() && (description.includes("CONVERSION") || description.includes("INTERIOR"))) {
            print("NetworkerV2: CRITICAL OPERATION - Using setValueImmediate for " + description);
            cellProp.setValueImmediate(this.gridSyncEntity.currentStore, newValue);
            print("NetworkerV2: CLOUD IMMEDIATE - Cell (" + x + ", " + y + ") " + description + ": claimed=" + newValue.x + ", staked=" + newValue.y);
        } else {
            // Use setPendingValue for normal operations
            cellProp.setPendingValue(newValue);
            print("NetworkerV2: CLOUD PENDING - Cell (" + x + ", " + y + ") " + description + ": claimed=" + newValue.x + ", staked=" + newValue.y);
        }
        
        // ALSO update local state for immediate reads (ensures consistency until cloud sync)
        this.localCellState.set(cellKey, newValue);
        this.localCacheTimestamps.set(cellKey, Date.now()); // Track when we cached this
        print("NetworkerV2: LOCAL CACHED - Cell (" + x + ", " + y + ") for immediate reads");
        
        return true;
    }
    
    //helper function to set ID of player for claiming
    setPlayerID(passedID: number, playerNumber: number){
        this.clientID = passedID;
        this.playerID = this.recyclePlayerNumsForVisuals(playerNumber); //player ids start at 1 (how many players are in game)
        print("NetworkerV2: client ID set to: " + this.clientID);
        print("NetworkerV2: player # is: " + this.playerID);
        if (this.gridReady) {
            this.writePlayerColorMapping();
        } else {
            this.pendingColorWrite = true;
        }
    }
    
    private writePlayerColorMapping(): void {
        const slot = this.playerColorSlots[this.playerID - 1];
        if (slot) {
            slot.setPendingValue(new vec2(this.clientID, this.playerID));
            print("NetworkerV2: Wrote player color mapping: clientID=" + this.clientID + " → playerID=" + this.playerID);
        }
    }

    getPlayerVisualID(clientID: number): number {
        for (let i = 0; i < this.playerColorSlots.length; i++) {
            const val = this.playerColorSlots[i].currentOrPendingValue;
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
            const val = prop.currentOrPendingValue;
            return (val && !isNaN(val.x)) ? val : vec2.zero();
        }
        return vec2.zero();
    }

    getMiniMapCells(centerX: number, centerY: number): (vec2 | null)[] {
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
                    if (cached) {
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
        return result;
    }

    //helper function to allow multiple players to have the same color sets (in order to not cap max player amount by number of unique color sets)
    recyclePlayerNumsForVisuals(playerNumber: number): number{
        //always returns 1-5 (if mod is 0 then it's false and the true value of 5 is returned)
        return (playerNumber % 5) || 5;
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
                print("NetworkerV2: Skipping sendData during bulk conversion");
            }
            return;
        }
        
        if (!this.gridReady) {
            if (this.showLogs) {
                print("NetworkerV2: SEND - Grid not ready, cannot send");
            }
            return;
        }
        
        // Get the cell property for this position
        const cellProp = this.getCellProperty(xpos, zpos);
        if (!cellProp) {
            print("NetworkerV2: ERROR - Could not get/create cell property");
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
            print("NetworkerV2: SEND - creating home claim with cloud storage");
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

        print("NetworkerV2: new cell is claimed by " + claimedBy + " and staked by " + stakedBy)

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

                // Delayed cloud write wins the race against the dead player's death-clear writes
                const delayedWrite = this.createEvent("DelayedCallbackEvent");
                delayedWrite.bind(() => {
                    this.updateCellValue(xpos, zpos, newCellValue, "STAKE");
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
            print("NetworkerV2: SEND - Successfully updated cell (" + xpos + ", " + zpos + ")");
        }
    }
    
    // function for accessing grid data
    getData(ID: number, xpos: number, zpos: number): vec2 {
        print("NetworkerV2: getData() called with ID=" + ID + ", xpos=" + xpos + ", zpos=" + zpos);
        
        // Always return a valid vec2, never undefined
        const fallbackVec = vec2.zero();
        
        try {
            if (!this.gridReady) {
                print("NetworkerV2: GET - Grid not ready, returning zero vec2");
                return fallbackVec;
            }
            
            print("NetworkerV2: GET REQUEST - Retrieving cell (" + xpos + ", " + zpos + ")");
            
            const cellKey = this.getCellKey(xpos, zpos);
            
            // FIRST: Check local state for immediate updates (handles race condition during bulk conversions)
            if (this.localCellState.has(cellKey)) {
                const cacheTimestamp = this.localCacheTimestamps.get(cellKey) || 0;
                const cacheAge = Date.now() - cacheTimestamp;
                
                // Use cache if it's fresh (less than 5 seconds old)
                if (cacheAge < 5000) {
                    const localValue = this.localCellState.get(cellKey);
                    print("NetworkerV2: ✅ GET LOCAL CACHE - Cell (" + xpos + ", " + zpos + "): claimed=" + localValue.x + ", staked=" + localValue.y + " (age: " + cacheAge + "ms)");
                    return localValue;
                } else {
                    // Cache is stale, remove it and fall through to cloud storage
                    print("NetworkerV2: 🗑️ STALE CACHE REMOVED - Cell (" + xpos + ", " + zpos + ") cache age: " + cacheAge + "ms");
                    this.localCellState.delete(cellKey);
                    this.localCacheTimestamps.delete(cellKey);
                }
            }
            
            // STANDARD: Use SpectaclesSyncKit's recommended currentOrPendingValue
            const cellProp = this.getCellProperty(xpos, zpos);
            if (!cellProp) {
                print("NetworkerV2: ERROR - Could not get cell property, returning zero vec2");
                return fallbackVec;
            }
            
            // Use currentOrPendingValue as recommended by docs for most recent value
            let cellVec = cellProp.currentOrPendingValue;
            if (!cellVec) {
                print("NetworkerV2: WARNING - Cell has no value, returning zero vec2");
                cellVec = fallbackVec;
            }
            
            // Ensure we have a valid vec2
            if (typeof cellVec.x === 'undefined' || typeof cellVec.y === 'undefined') {
                print("NetworkerV2: ERROR - Invalid vec2 structure, returning zero vec2");
                print("NetworkerV2: cellVec type: " + typeof cellVec + ", value: " + cellVec);
                return fallbackVec;
            }
            
            print("NetworkerV2: GET CLOUD - Cell (" + xpos + ", " + zpos + "): claimed=" + cellVec.x + ", staked=" + cellVec.y);
            
            // Log if this is a problematic stake that should have been converted
            if (cellVec.y === ID) {
                print("  ⚠️ WARNING: Cell is still staked by player " + ID + " - Cloud storage may not have persisted yet!");
            }
            
            print("NetworkerV2: Returning valid vec2: " + cellVec);
            return cellVec;
            
        } catch (error) {
            print("NetworkerV2: EXCEPTION in getData(): " + error);
            print("NetworkerV2: Returning fallback zero vec2");
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
    
    //function for handling player death
    handlePlayerDeath(ID: number){
        print("NetworkerV2: Player " + ID + " has died");
        
        // Mark player as dead
        if (ID === this.clientID) {
            this.isAlive = false;
            this.firstClaim = true; // Allow new home claim on respawn
            this.stakeList = []; // Clear stake list
        }
        
        // Clear all claims and stakes for the dead player
        // We need to iterate through all initialized cells
        for (const [key, cellProp] of this.gridCells) {
            const currentValue = cellProp.currentOrPendingValue || vec2.zero();
            let needsUpdate = false;
            let newValue = new vec2(currentValue.x, currentValue.y);
            
            // Clear claim if owned by dead player
            if (currentValue.x === ID) {
                newValue.x = 0;
                needsUpdate = true;
            }
            
            // Clear stake if owned by dead player
            if (currentValue.y === ID) {
                newValue.y = 0;
                needsUpdate = true;
            }
            
            // Update cell if needed
            if (needsUpdate) {
                // Parse coordinates from key (format: "cell_x_y")
                const keyParts = key.split('_');
                if (keyParts.length === 3) {
                    const cellX = parseInt(keyParts[1]);
                    const cellY = parseInt(keyParts[2]);
                    this.updateCellValue(cellX, cellY, newValue, "DEATH CLEAR");
                } else {
                    // Fallback to direct property update if key parsing fails
                    if (this.gridSyncEntity.canIModifyStore()) {
                        cellProp.setValueImmediate(this.gridSyncEntity.currentStore, newValue);
                    } else {
                        cellProp.setPendingValue(newValue);
                    }
                }
            }
        }
        
        //despawn all cell visuals (claims and stakes) associated with self
        if (ID === this.clientID) {
            // Clear local state for dead player
            this.localCellState.clear();
            this.localCacheTimestamps.clear();
            print("NetworkerV2: Local state cleared for dead player " + ID);
            
            this.PlayerVisuals.DestroyAllStakes();
            this.PlayerVisuals.DestroyAllClaims();
        }
    }
    
    //function for returning to claimed region and adding staked region to claim
    addStakedRegionToClaim(realWorldCoords: vec3){
        // Prevent multiple bulk conversions from happening simultaneously
        if (this.isPerformingBulkConversion) {
            print("NetworkerV2: Bulk conversion already in progress, skipping");
            return;
        }
        
        //if no stakes exist, return early
        const numOfStakes = this.stakeList.length;
        if (numOfStakes == 0){
            return;
        }
        
        this.isPerformingBulkConversion = true; // Set flag to prevent re-entry
        print("NetworkerV2: BULK CONVERSION START - Converting " + numOfStakes + " stakes to claims with proper cloud storage");
        
        // Destroy stake visuals immediately
        this.PlayerVisuals.DestroyAllStakes();
        
        // Create copy of stakeList for processing
        const stakesToConvert = [...this.stakeList];
        
        // Clear the stake list early to prevent new stakes during conversion
        this.stakeList = [];
        print("NetworkerV2: stakeList cleared, length now: " + this.stakeList.length);
        
        // Start sequential conversion with proper cloud storage callbacks
        this.convertStakesSequentially(stakesToConvert, 0, realWorldCoords, () => {
            print("NetworkerV2: ✅ ALL STAKES SUCCESSFULLY CONVERTED TO CLOUD STORAGE!");
            
            // Find and fill enclosed region after successful conversion
            this.findAndFillEnclosedRegion(stakesToConvert, realWorldCoords);
            
            // Reset the conversion flag
            this.isPerformingBulkConversion = false;
            print("NetworkerV2: 🔄 Bulk conversion flag RESET - Normal operations resumed");
        });
    }
    
    // New method: Sequential stake conversion with proper cloud storage callbacks
    private convertStakesSequentially(stakes: vec2[], index: number, realWorldCoords: vec3, onComplete: () => void) {
        if (index >= stakes.length) {
            print("NetworkerV2: Sequential conversion completed for all " + stakes.length + " stakes");
            onComplete();
            return;
        }
        
        const stake = stakes[index];
        print("NetworkerV2: [" + (index + 1) + "/" + stakes.length + "] Converting stake at (" + stake.x + ", " + stake.y + ")");
        
        const cellProp = this.getCellProperty(stake.x, stake.y);
        if (!cellProp) {
            print("NetworkerV2: ERROR - Could not get cell property for stake conversion");
            // Continue with next stake
            this.convertStakesSequentially(stakes, index + 1, realWorldCoords, onComplete);
            return;
        }
        
        const currentValue = cellProp.currentOrPendingValue || vec2.zero();
        print("  BEFORE: claimed=" + currentValue.x + ", staked=" + currentValue.y);
        
        // Verify this cell is actually staked by us
        if (currentValue.y !== this.clientID) {
            print("  WARNING: Cell not staked by us! Staked by: " + currentValue.y + ", our ID: " + this.clientID);
        }
        
        // Convert stake to claim (set x to clientID, y to 0)
        const newValue = new vec2(this.clientID, 0);
        
        // Use helper method to ensure both local state and cloud storage are updated
        const success = this.updateCellValue(stake.x, stake.y, newValue, "STAKE→CLAIM CONVERSION");
        
        if (success) {
            print("  ✅ CONVERSION SUCCESS: Stake (" + stake.x + ", " + stake.y + ") → Claim");
            print("  AFTER: claimed=" + newValue.x + ", staked=" + newValue.y);
            
            //Create visual for newly claimed cell (exterior loop cell)
            const cellCenterCoords = this.gridPosToWorldCoords(stake.x, stake.y);
            //print("test first claim by id: " + this.playerID);
            this.PlayerVisuals.createWorldClaimVolume(this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell);
            
            // Add small delay to allow SpectaclesSyncKit to sync to cloud
            const delayedEvent = this.createEvent("DelayedCallbackEvent");
            delayedEvent.bind(() => {
                // Continue to next stake after delay
                this.convertStakesSequentially(stakes, index + 1, realWorldCoords, onComplete);
            });
            delayedEvent.reset(0.04); // 40ms delay per conversion
        } else {
            print("  ❌ CONVERSION FAILED: Could not convert stake (" + stake.x + ", " + stake.y + ")");
            // Continue to next stake even on failure
            this.convertStakesSequentially(stakes, index + 1, realWorldCoords, onComplete);
        }
    }
    
    //main function for filling loop of cells
    findAndFillEnclosedRegion(loop: vec2[], realWorldCoords: vec3) {
        //calculate edges of loop
        const edges = this.getLoopEdges(loop);
        
        //start the mins at infinity and maxes at -infinity
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        
        //iterate over cells in the stake loop and update smallest & largest values
        for (const cell of loop) {
            minX = Math.min(minX, cell.x);
            maxX = Math.max(maxX, cell.x);
            minZ = Math.min(minZ, cell.y);
            maxZ = Math.max(maxZ, cell.y);
        }
        
        // Early return if the bounding box has no interior
        if (maxX - minX <= 1 || maxZ - minZ <= 1) {
            print("NetworkerV2: findAndFillEnclosedRegion: stake bounding box has no interior, returning early.");
            return;
        }
        
        // Collect interior cells first
        const interiorCells: vec2[] = [];
        
        //loop from smallest x & y to largest (encompass rectangle spanning the entire loop)
        for (let x = minX + 1; x < maxX; x++) {
            for (let z = minZ + 1; z < maxZ; z++) {
                const gridPos = new vec2(x, z);
                
                // Check if cell is not on the loop boundary and is inside the loop
                if (!loop.some(v => this.vec2Equals(v, gridPos)) && this.isInLoop(x, z, edges)) {
                    interiorCells.push(gridPos);
                }
            }
        }
        
        if (interiorCells.length === 0) {
            print("NetworkerV2: No interior cells found to claim");
            return;
        }
        
        print("NetworkerV2: Found " + interiorCells.length + " interior cells to claim with cloud storage");
        
        // Convert interior cells using cloud storage (similar to stake conversion)
        this.claimInteriorCellsSequentially(interiorCells, 0, realWorldCoords, () => {
            print("NetworkerV2: ✅ All interior cells successfully claimed in cloud storage!");
            print("NetworkerV2: Scanline region fill complete!");
        });
    }
    
    // New method: Sequential interior cell claiming with proper cloud storage callbacks
    private claimInteriorCellsSequentially(cells: vec2[], index: number, realWorldCoords: vec3, onComplete: () => void) {
        if (index >= cells.length) {
            print("NetworkerV2: Sequential interior claiming completed for all " + cells.length + " cells");
            onComplete();
            return;
        }
        
        const cell = cells[index];
        print("NetworkerV2: [" + (index + 1) + "/" + cells.length + "] Claiming interior cell at (" + cell.x + ", " + cell.y + ")");
        
        const cellProp = this.getCellProperty(cell.x, cell.y);
        if (!cellProp) {
            print("NetworkerV2: ERROR - Could not get cell property for interior cell");
            // Continue with next cell
            this.claimInteriorCellsSequentially(cells, index + 1, realWorldCoords, onComplete);
            return;
        }
        
        // Claim this interior cell
        const newValue = new vec2(this.clientID, 0);
        
        // Use helper method to ensure both local state and cloud storage are updated
        const success = this.updateCellValue(cell.x, cell.y, newValue, "INTERIOR CLAIM");
        
        if (success) {
            print("  ✅ INTERIOR CELL CLAIMED: (" + cell.x + ", " + cell.y + ") updated");
            
            // Create visual for newly claimed cell
            const cellCenterCoords = this.gridPosToWorldCoords(cell.x, cell.y);
            //print("test first claim by id: " + this.playerID);
            this.PlayerVisuals.createWorldClaimVolume(this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell);
            
            // Add small delay to allow SpectaclesSyncKit to sync to cloud
            const delayedEvent = this.createEvent("DelayedCallbackEvent");
            delayedEvent.bind(() => {
                // Continue to next cell after delay
                this.claimInteriorCellsSequentially(cells, index + 1, realWorldCoords, onComplete);
            });
            delayedEvent.reset(0.05); // 50ms delay per claim
        } else {
            print("  ❌ INTERIOR CLAIM FAILED: Could not claim cell (" + cell.x + ", " + cell.y + ")");
            // Continue to next cell even on failure
            this.claimInteriorCellsSequentially(cells, index + 1, realWorldCoords, onComplete);
        }
    }
    
    // Convert loop to array of segments
    getLoopEdges(loop: vec2[]): [number, number, number, number][] {
        const edges: [number, number, number, number][] = [];
        for (let i = 0; i < loop.length; i++) {
            const x1 = loop[i].x;
            const y1 = loop[i].y;
            const secondCellIdx = (i + 1) % loop.length;
            const x2 = loop[secondCellIdx].x;
            const y2 = loop[secondCellIdx].y;
            edges.push([x1, y1, x2, y2]);
        }
        return edges;
    }
    
    // Check if a point is inside the loop using ray casting
    isInLoop(x: number, y: number, edges: [number, number, number, number][]): boolean {
        let count = 0;
        for (const [x1, y1, x2, y2] of edges) {
            if ((y1 > y) !== (y2 > y)) {
                const xCross = ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
                if (xCross > x) count++;
            }
        }
        return count % 2 == 1;
    }
    
    // Helper function to compare vec2
    vec2Equals(v1: vec2, v2: vec2): boolean {
        return v1.x === v2.x && v1.y === v2.y;
    }
}