import {SessionController} from '../SpectaclesSyncKit/Core/SessionController';
import {StorageProperty} from "SpectaclesSyncKit/Core/StorageProperty"
import {SyncEntity} from "SpectaclesSyncKit/Core/SyncEntity"
import {SyncKitLogger} from "SpectaclesSyncKit/Utils/SyncKitLogger"
import { PlayerVisuals } from './PlayerVisuals';

@component
export class Networker extends BaseScriptComponent {
    //to help debug
    showLogs: boolean = true;
    //connection id
    clientID: number;
    
    playerID: number;//equal to numbers of players (after self joined) - 1 (for instantiator prefab list referencing)
    
    gridSyncEntity: SyncEntity;
    
    // Initialize the array of data (all zeroes on start)
    private gridArray: vec2[] = []
    
    // Create a storage property for the gridSyncEntity
    private gridData: StorageProperty<vec2[]> //vector 2 array of <0,0> with unique, unrelated elemenets
    
    private height = 40; //the length and width (in number of cells) of the grid cube
    
    private gridRadius = this.height / 2; //the radius is half of the diameter (the height & width of square)
    
    unitsPerCell: number = 200;//cells size in centimeters (also in gridclaimer which is getting phased out)
    
    private lastIdx = this.height * this.height; //last index in the grid (square of that is height tall and height wide)
    
    private gridReady = false; //flag for grid being ready to use
    
    private firstClaim = true; //flag to create home claim on start
    
    //player visuals script for minimap and world objects
    @input
    PlayerVisuals: PlayerVisuals;
    
    stakeList: vec2[] = []; //keep track of stake cells (in order)
    
    isAlive = true; //keep track of alive status of self
    
    deathEventString = 'playerDeathEvent';
    
    //script to manager the grid claim modification permissions
    onAwake() {
        // Initialize the grid array properly
        this.gridArray = []
        for (let i = 0; i < this.height * this.height; i++) {
            this.gridArray.push(vec2.zero());//make sure it starts with all zeros
        }
        //check grid array data
        if (this.showLogs) {
            print("NetworkerTS: Grid array initialized with length: " + this.gridArray.length);
            print("NetworkerTS: First element: " + this.gridArray[0]);
            print("NetworkerTS: Elements are independent: " + (this.gridArray[0] !== this.gridArray[1]));
        }
        
        // Create the storage property after array initialization
        this.gridData = StorageProperty.manualVec2Array("serverGrid", this.gridArray);
        //print out that storage property was created
        if (this.showLogs) {
            print("NetworkerTS: Storage property created");
        }
        
        // Create new sync entity for this script (exactly like ControllerTS)
        this.gridSyncEntity = new SyncEntity(this);
        
        if (this.showLogs) {
            print("NetworkerTS: Sync entity created")
        }
        
        // Add storage properties for grid data
        this.gridSyncEntity.addStorageProperty(this.gridData);
        //print out storage property was added successfully
        if (this.showLogs) {
            print("NetworkerTS: Storage property added to sync entity")
        }
        
        // Limit the grid to only send updates out 10 times per second
        this.gridData.sendsPerSecondLimit = 10
        
        // Add change listener for storage property updates
        this.gridData.onAnyChange.add((newVal: vec2[], oldVal: vec2[]) => {
            //update minimap here if changed cell(s) are within minimap radius
            if (this.showLogs) {
                print("NetworkerTS: Grid data changed!")
                print("NetworkerTS: New value's length: " + (newVal ? newVal.length : "undefined"))
                print("NetworkerTS: Old value's length: " + (oldVal ? oldVal.length : "undefined"))
            }
        })
        //print out that onAnyChange has a function
        if (this.showLogs) {
            print("NetworkerTS: Change listener added")
        }
        
        // Set up the sync entity notify on ready callback (exactly like ControllerTS)
        // Note: Only update the sync entity once it is ready
        this.gridSyncEntity.notifyOnReady(() => this.onReady())
        
    }
    
    //called when grid sync entity and session controller are ready
    onReady() {
        if (this.showLogs) {
            print("NetworkerTS: onReady called")
        }
        
        // Debug the storage property state
        print("NetworkerTS: Grid array length: " + this.gridArray.length)
        print("NetworkerTS: Grid data current value: " + this.gridData.currentValue)
        print("NetworkerTS: Grid data current value's length: " + (this.gridData.currentValue ? this.gridData.currentValue.length : "undefined"))
        print("NetworkerTS: Grid data currentOrPendingValue: " + this.gridData.currentOrPendingValue)
        print("NetworkerTS: Grid data currentOrPendingValue length: " + (this.gridData.currentOrPendingValue ? this.gridData.currentOrPendingValue.length : "undefined"))
        
        // Make sure all cells are independent (this prints false, which is the desired outcome)
        print("NetworkerTS: Elements are independent: " + (this.gridArray[0] === this.gridArray[1])) // Should be false if they're independent
        
        // Set the pending value here
        this.gridData.setPendingValue(this.gridArray);
        
        //TODO: set up death event listener
        this.gridSyncEntity.onEventReceived.add(this.deathEventString, (messageInfo) => {
            //data is vec2 of who got killed (x val) and who killed them (y val)
            const deathData = messageInfo.data;
            this.playerDeath(deathData.x, deathData.y);
        });
        
        // Set ready flag so grid can be used
        this.gridReady = true;
        
        if (this.showLogs) {
            print("NetworkerTS: Grid is ready!")
        }
    }
    
//    //to update the shared storage property given a player's location
//    receivePlayerData(ID: number, xpos: number, ypos: number, zpos: number){
//        //return early if grid is not ready        
//        if (!this.gridReady){
//            return;
//        }
//        //calculate the array index based on x and y
//        let idx = this.height * ypos + xpos;
//        //check if index is OOB
//        if (idx < 0 || idx >= this.gridData.currentValue.length) {
//            print(`Invalid grid index: ${idx} for x=${xpos}, y=${ypos}`);
//            return;
//        }
//        //the vector2 state represents the claim and stake status (in order) of the cell
//        let cellVec = this.gridData.currentValue[idx];
//        //get owner and staker of grid cell
//        let claimOwner = cellVec.x;
//        let stakeOwner = cellVec.y;
//    }
    
    //setter for player id (hashed display name from session controller)
    setPlayerID(ID: number, playerNum: number){
        this.clientID = ID;
        this.playerID = playerNum - 1; //have players zero indexed to support unique cell colors
        print("NetworkerTS: new player has ID of " + ID + " and player number of " + playerNum);
    }
    
    //networked event called by one received by all (check if param == self id and if so call handlePlayerDeath)
    playerDeath(deadID: number, killerID: number) {
        print("player " + killerID + " killed player " + deadID + " self is " + this.clientID);
        //kill player if network event says they are the one who died
        if (deadID == this.clientID){
            this.isAlive = false;
            print("player " + deadID + " is calling handle death");
            this.handleDeath();
        }
        
    }

    

    //this is the userId of the client with this script
    //sessionController.getLocalUserId()
    
    //meet with spectacles team to:
    //1: get multiple previews of same session emulating multiplayer
    
    //this function is called whenever self moves into a cell
    //function to update grid data (grid cell is vec2 representing claim and stake owner(s))
    sendData(ID: number, xpos: number, zpos: number, realWorldCoords: vec3) {
        //if player is dead, return early (they can't stake, claim, or kill)
        if (!this.isAlive){
            return;
        }
        
        //if not staked, stake
        //if staked, owner of stake dies (even if self)
        
        //if claimed:
        //      by self: check if stake loop exists and add to claim
        //      by other: update stake data in cell without updating claim
        if (this.showLogs) {
            print("NetworkerTS: TEST - Starting send test");
        }
        
        if (!this.gridReady) {
            if (this.showLogs) {
                print("NetworkerTS: TEST - Grid not ready, cannot send");
            }
            return;
        }
        
        // Use currentOrPendingValue as recommended in documentation
        const currentData = this.gridData.currentOrPendingValue;
        if (!currentData) {
            if (this.showLogs) {
                print("NetworkerTS: TEST - Grid data is null, cannot send");
            }
            return;
        }
        
        //get index associated with grid coordinates to access grid data (single dimension array)
        let idx = this.coordsToIndex(xpos, zpos);
        if (idx < 0 || idx >= currentData.length) {
            if (this.showLogs) {
                print("NetworkerTS: TEST - Invalid index: " + idx);
            }
            return;
        }
        
        //special/base case of creating home claim on start
        if (this.firstClaim == true){
            print("NetworkerTS: TEST - creating home claim");
            //set first claim to false to not allow multiple home claims
            this.firstClaim = false;
            // Create a copy of the current array
            let newArray = [...currentData];
            // Build brand new array + objects
//            const newArray = currentData.map((cell, i) =>
//                i === idx ? new vec2(this.clientID, 0) : new vec2(cell.x, cell.y)
//            )
            //home claim is claimed by self and staked by none
            let homeClaimVal = new vec2(0, 0);  // initialize
            homeClaimVal.x = ID;     // set claimed by client id
            homeClaimVal.y = 0;
            //update specified index with new value
            newArray[idx] = homeClaimVal;
            // Set the new value
            this.gridData.setPendingValue(newArray);
            print("NetworkerTS: new home claim " + newArray[idx])
            //calculate the center of current cell for visuals
            const cellCenterCoords = this.gridPosToWorldCoords(xpos, zpos);
            this.PlayerVisuals.createWorldClaimVolume(cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell);
            return;//can return early now that backend and frontend home claim tasks are handled
        }
        
        //use current data at current index to determine next step
        const cellValue = currentData[idx];
        const claimedBy = cellValue.x;
        const stakedBy = cellValue.y;
        
        print("NetworkerTS: new cell is claimed by " + claimedBy + " and staked by " + stakedBy)
        //a cell can be claimed and staked by different players (not the same)
        //if staked by a player (will be 0 if not staked)
        if (stakedBy != 0){
            //TODO: test death event (have killed player call handlePlayerDeath and despawn cell visuals)
            print("attempting to call death event");            
            this.gridSyncEntity.sendEvent(this.deathEventString, new vec2(stakedBy, this.clientID)); //pass who died (x val) and who killed them (y val)
            
        }
        //if claim is by self (ID param) claim any staked area
        else if (claimedBy == ID){
            //check for any staked region (continue if no staked region exists)
            //convert stakes to claims  
            //fill potential loop area
            this.addStakedRegionToClaim(realWorldCoords);
        }
        //if claim is not by self (or unclaimed), stake cell
        else {
            //stake any cell not claimed by self (update gridData, stakeList, and visuals)
            cellValue.y = ID; //stake cell information passed to gridData (update y val to ID)
            this.stakeList.push(new vec2(xpos, zpos)); //add to stakeloop
            //cell is staked by updating gridData with new cellValue y val
            const cellCenterCoords = this.gridPosToWorldCoords(xpos, zpos);
            //create player visual for newly staked cell at center of cell and at current y
            this.PlayerVisuals.createWorldStakeVolume(cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell);
        }
        
        
        if (this.showLogs) {
            print("NetworkerTS: TEST - Updating position (" + xpos + ", " + zpos + ") to " + cellValue);
        }
        
        // Create a copy of the current array
        let newArray = [...currentData];
        //update specified index with new value
        newArray[idx] = cellValue;
        
        // Set the new value
        this.gridData.setPendingValue(newArray);
        
        if (this.showLogs) {
            print("NetworkerTS: TEST - Successfully sent update");
        }
    }
    
    
    // function for accessing grid data
    getData(ID: number, xpos: number, zpos: number): vec2 {

        if (this.showLogs) {
            print("NetworkerTS: TEST RECEIVE - Testing position (" + xpos + ", " + zpos + ")");
        }
        
        if (!this.gridReady) {
            if (this.showLogs) {
                print("NetworkerTS: TEST RECEIVE - Grid not ready, cannot test");
            }
            return;
        }
        
        //get index associated with grid coordinates to access grid data (single dimension array)
        let idx = this.coordsToIndex(xpos, zpos);
        
        // Use currentOrPendingValue as recommended in documentation
        const currentData = this.gridData.currentOrPendingValue;
        
        if (this.showLogs) {
            print("NetworkerTS: TEST RECEIVE - Calculated index: " + idx);
            print("NetworkerTS: TEST RECEIVE - Grid data currentOrPendingValue: " + currentData);
            print("NetworkerTS: TEST RECEIVE - Grid data currentOrPendingValue length: " + (currentData ? currentData.length : "undefined"));
        }
        
        if (!currentData) {
            print("NetworkerTS: TEST RECEIVE - Grid data is null, cannot test");
            return;
        }
        
        // Check if index is OOB
        if (idx < 0 || idx >= currentData.length) {
            print("NetworkerTS: TEST RECEIVE - Invalid grid index: " + idx + " for x=" + xpos + ", y=" + zpos);
            return;
        }
        
        // get the cell vector from the specified retieve index
        let cellVec = currentData[idx];
        
        if (this.showLogs) {
            print("NetworkerTS: TEST RECEIVE - Retrieved cellVec: " + cellVec);
        }
        
        if (cellVec === undefined) {
            print("NetworkerTS: TEST RECEIVE - ERROR - cellVec is undefined at index " + idx);
        } else {
            print("NetworkerTS: TEST RECEIVE - SUCCESS - cellVec retrieved: " + cellVec);
        }
        //return the vector 2 that the parameters requested
        return cellVec;
    }
    
    //returns index for gridata of the x and z coordinates of the grid (parameters)
    //z is vertical (thus multiply by height) and x is horizontal and is 1:1 with cells
    coordsToIndex(xCoord: number, zCoord: number): number {
        // Calculate the array index based on x and y
        //each z goes down one row, which increases index by height (grid is square) so multiply z by height
        //each x is 1:1 with grid columns so just add
        return this.height * zCoord + xCoord;
    }
    
    // Converts grid position back to world coordinates (center of the cell)
    gridPosToWorldCoords(col: number, row: number): vec2 {
        //current cell (0-40) - 20 = signed number of cells away from origin
        const xOffset = col - this.gridRadius;
        const yOffset = row - this.gridRadius;
        //multiply # of cells from origin by units per cell to get units from origin
        const x = xOffset * this.unitsPerCell;
        const y = yOffset * this.unitsPerCell;
        return new vec2(x, y);
    }
    
    //returns vec2 grid coordinate correlating to index of griddata
    indexToCoords(idx: number): vec2 {
        const x = idx % this.height;
        const z = Math.floor(idx / this.height);
        return new vec2(x, z);
    }

    
    
    //function to remove all stakes and claims (and visuals) associated with self
    handleDeath(){
        print("handle death function called");
        // Use currentOrPendingValue as recommended in documentation
        const currentData = this.gridData.currentOrPendingValue;
        
        // Create a copy of the current array
        let newArray = [...currentData];
        
        //loop through current data grid and remove all stakes and claims of player ID
        for (var i = 0; i < this.lastIdx; i++){ //have each player keep list of staked and claimed instead
            //retrieve cell with specified index
            const currCell = newArray[i];
            //if either x (claim) or y (stake) == ID, set to 0 to indicate player death
            if (currCell.x == this.clientID){ //check if staked == ID
                const newValue = new vec2(0, currCell.y); //set claim to 0 and keep staked val
                newArray[i] = newValue; //update specified index with new value
            }
            if (currCell.y == this.clientID){ //check if staked == ID
                const newValue = new vec2(currCell.x, 0); //set stake to 0 and keep claimed val
                newArray[i] = newValue; //update specified index with new value
            }
        }
        
        // Set the grid status (now with no stakes of claims by player with ID)
        this.gridData.setPendingValue(newArray);
        
        //despawn all cell visuals (claims and stakes) associated with self
        this.PlayerVisuals.DestroyAllStakes();
        this.PlayerVisuals.DestroyAllClaims();
        
        //TODO: set player with ID as dead and disable their staking/claiming ability        
        
        //dont worry about respawning/reviving dead players for now
        //once dead player reaches unclaimed cell, create new home claim
    }
    
    
    //function for returning to claimed region and adding staked region to claim
    addStakedRegionToClaim(realWorldCoords: vec3){
        
        //1: if stakes.length == 0 (there are no stakes) then return early
        const numOfStakes = this.stakeList.length;
        if (numOfStakes == 0){
            return; //if no stakes exist, simply return early
        }
        //(at this point there is a staked loop to claim)
        
        //2: get all player stakes as a list of integers
        // Use currentOrPendingValue as recommended in documentation
        const currentData = this.gridData.currentOrPendingValue;
        // Create a copy of the current array
        let newArray = [...currentData];
        
        //3: destroy stake visuals
        this.PlayerVisuals.DestroyAllStakes();
        
        //4: convert all stakes to claims (set x val to clientID and y val with 0)
        for (var i = 0; i < numOfStakes; i++){
            const currCell = newArray[i];
            const newValue = new vec2(this.clientID, 0); //set claim to client ID and set stake to 0 (unstaked)
            newArray[i] = newValue; //update specified index with new value
        }
        
        //5: Find the enclosed area (now surrounded by claimed cells) for each cell on/within stake loop:
        //5.a: claim it (handled in findAndFill)
        //5.b: insantiate visuals (handled in findAndFill)
        this.findAndFillEnclosedRegion(this.stakeList, newArray, realWorldCoords);
        
        //6: update gridData with data from newly computed (by findAndFillEnclosedRegion) grid
        this.gridData.setPendingValue(newArray);
    }
    
    //TODO: finish functionality for updating newGrid data (it's by ref so no need to return array)
    //main function for filling loop of cells (grid loop can be part/completely diagonal and multiple cells thick)
    findAndFillEnclosedRegion(loop: vec2[], newGrid: vec2[], realWorldCoords: vec3) {
        //create set of vec2 in order to not repeat claims
        const loopSet = new Set(loop);
        //calculate edges of loop
        const edges = this.getLoopEdges(loop);
        
        //start the mins at -infinity and maxes at infinity
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        //iterate over cells in the stake loop (the boundary of the new claim) and update smallest & largest values
        for (const cell of loop) {
            //get min and maxes for both x and y (actually z value)
            minX = Math.min(minX, cell.x);
            maxX = Math.max(maxX, cell.x);
            minZ = Math.min(minZ, cell.y);
            maxZ = Math.max(maxZ, cell.y);
        }
        
        //loop from smallest x & y to largest (encompass rectangle spanning the entire loop)
        for (let x = minX + 1; x < maxX; x++) {
            for (let z = minZ + 1; z < maxZ; z++) {
                //check if loop doesn't already contains key and that it is within stake loop
                const gridPos = new vec2(x, z);
                if (!loopSet.has(gridPos) && this.isInLoop(x, z, edges)) {
                    //claim cell at x, y under clientID
                    let idx = this.coordsToIndex(x, z); //calculate index of given x and z
                    const currCell = newGrid[idx]; //get cell at given grid coords
                    const newValue = new vec2(this.clientID, currCell.y); //set claim to client ID and keep stake (should be unstaked)
                    newGrid[idx] = newValue; //update specified index with new value
                    //create player visual for given cell at center of cell (now claimed)
                    const cellCenterCoords = this.gridPosToWorldCoords(x, z);
                    this.PlayerVisuals.createWorldClaimVolume(cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell);
                }
            }
        }
        
        print("Scanline region fill complete!");
    }
    
    //TODO: test this function (has been converted to use vec2)
    // Step 1: Convert loop to array of segments
    getLoopEdges(loop: vec2[]): [number, number, number, number][] {
        //keep track of all edges
        const edges: [number, number, number, number][] = [];
        //iterate over stake loop (now connected to home claim)
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
    
    // Step 2: Check if a point is inside the loop using ray casting
    isInLoop(x: number, y: number, edges: [number, number, number, number][]): boolean {
        let count = 0;
        //iterate through all edges
        for (const [x1, y1, x2, y2] of edges) {
            if ((y1 > y) !== (y2 > y)) {
                const xCross = ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
                if (xCross > x) count++;
            }
        }
        //if raycase hit an odd number of times, coords are inside stake loop
        return count % 2 === 1;
    }

    
    
    
}
