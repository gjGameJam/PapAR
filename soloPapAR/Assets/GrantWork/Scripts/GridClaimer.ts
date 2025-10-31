import { PlayerVisuals } from './PlayerVisuals';
import { SessionController } from "SpectaclesSyncKit.lspkg/Core/SessionController";

@component
export class GridClaimer extends BaseScriptComponent {
    
    unitsPerCell: number = 200;//cells are this number by this number centimeters (also in networker)
    gridRadius: number = 20;
    grid: SparseGrid = new SparseGrid(this.gridRadius * 2); // Initialize the grid as gridDiameter * gridDiameter
    currX: number = 400;
    currY: number = 400;
    currZ: number = 400;
    prevX: number = 400;
    prevZ: number = 400;
    hasPrev: boolean = false; //has prev coords
    playerID: number = 0;
    DEGREES_TO_RADIANS = Math.PI / 180;
    
    //player visuals script for minimap and world objects
    @input
    PlayerVisuals: PlayerVisuals;
    
    //session controller singleton instance
    seshController: SessionController = SessionController.getInstance();
    
    
    //function called by location tracker script grid coordinates change
    updatePos(worldX : number, worldY : number, worldZ : number, gridPos : vec2){
        //print('location has been updated');
            
        //get the CellState of the grid cell
        const currState = this.grid.getCellState(gridPos.x, gridPos.y);
            
        //the state of the grid cell matters, handle interaction
        if (currState === CellState.STAKED) {
            //stake owner dies and their stakes + claims return unclaimed
            print('player hit their own stake');
            this.handlePlayerDeath(this.playerID);
        }
        else if (currState === CellState.UNCLAIMED) {
            // player drops stake on unclaimed land
            this.stakeNewCell(gridPos.x, gridPos.y, this.playerID);
        }
        else if (currState === CellState.CLAIMED) {
            //once player returns to their own claim. claim any staked region
            this.addStakedRegionToClaim();
//          const owner = this.grid.getClaimOwner(gridPos.x, gridPos.y);
//            if (owner === this.playerID) {
//                // expand claim to include area encompassed by claim loop
//                this.addStakedRegionToClaim();
//            }
//            else {
//                //multiplayer: if the claim owner is in the entered cell, you die
//                // player drops stake on claim (that isn't theirs yet)
//                this.grid.stakeCell(gridPos.x, gridPos.y, this.playerID);
//            }
            }
            
            //update the minimap with new cell colors
            this.PlayerVisuals.updateMiniMap(gridPos, this.grid);
        //}
    }
    
    //unclaim and unstake all
    handlePlayerDeath(deadPlayerID: number){
                
        //Destroy all volumes for cell claims and stakes
        this.PlayerVisuals.DestroyAllClaims();
        this.PlayerVisuals.DestroyAllStakes();
        
        // Collect all staked cells belonging to the player
        const stakePositions = this.grid.getPlayerStakes(deadPlayerID);
        const claimPositions = this.grid.getPlayerClaims(deadPlayerID);
        
        // Unstake all
        for (const cell of stakePositions) {
            const [x, y] = cell.split(',').map(Number);
            this.grid.unstakeCell(x, y);
        }
    
        // Unclaim all
        for (const cell of claimPositions) {
            const [x, y] = cell.split(',').map(Number);
            this.grid.unclaimCell(x, y);
        }
        
        const GridPos = this.worldCoordsToGridPos(new vec2(this.currX, this.currZ));
        //world origin is device handler's (0,0,0)
        this.claimSparseCell(GridPos.x, GridPos.y, deadPlayerID);
        
    }
    
    // Converts world coordinates to grid position (centered at 0,0 = center of center cell)
    worldCoordsToGridPos(wPos: vec2): vec2 {
        //world offset units divided by unit per cell = cell offset
        const cellX = wPos.x / this.unitsPerCell;
        const cellY = wPos.y / this.unitsPerCell;
        //want to be in center of cell so add .5
        //want to be in center of grid so add gridradius
        const offset = this.gridRadius + 0.5;
        //always want grid # to be int so floor offset + cellPos to get grid #
        const col = Math.floor(cellX + offset);
        const row = Math.floor(cellY + offset);
    
        return new vec2(col, row);
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
    
    //wrapped function for staking a new cell
    stakeNewCell(x: number, y: number, player: number){
        //create visual for stake by getting appropriate world pos then calling player visuals
        const worldXZ = this.gridPosToWorldCoords(x, y);
        this.PlayerVisuals.createWorldStakeVolume(1, worldXZ.x, this.currY, worldXZ.y, this.unitsPerCell);
        //update the sparse grid
        this.grid.stakeCell(x, y, player);
    }

    
    //updates the current and previous world pos x and z (we dont care about y)
    setCurrAndPrev(newX: number, newY: number, newZ: number) {
        if (!this.hasPrev) {
            if (this.currX === 400) {
                // First call: Initialize current position
                this.currX = newX;
                this.currY = newY;
                this.currZ = newZ;
                //create grid on start
                this.createInitialGrid(); // Create the grid when the world origin is set
                //TODO: create home claim on start
                const GridPos = this.worldCoordsToGridPos(new vec2(this.currX, this.currZ));
                //world origin is device handler's (0,0,0)
                this.claimSparseCell(GridPos.x, GridPos.y, this.playerID);
                print('player claimed home region');
                return;
            }
            // Second call: Set previous position
            this.prevX = this.currX;
            this.prevZ = this.currZ;
            this.hasPrev = true;
        } else {
            // 3rd+ call: Shift current to previous and update new position
            this.prevX = this.currX;
            this.prevZ = this.currZ;
        }
        // Always update the current position
        this.currX = newX;
        this.currY = newY;
        this.currZ = newZ;
    }
    
    //function to create big unclaimed grid around player
    createInitialGrid() {
        // Create a gridRadiusxgridRadius grid area around the player
        for (let x = -this.gridRadius; x <= this.gridRadius; x++) {
            for (let y = -this.gridRadius; y <= this.gridRadius; y++) {
                this.grid.unclaimCell(x, y); // Initialize all cells as unclaimed
            }
        }
        print("Grid initialized.");
    }
    
    //add the staked cells to claim, then claim all cells inside stake loop and claim line
    addStakedRegionToClaim(){
        // Collect all staked cells belonging to the player
        const stakePositions = this.grid.getPlayerStakes(this.playerID);
        if (stakePositions.length == 0){
            //print('no staked region to add to claim');
            return;
        }
        //print('adding staked region to claim');
        //remove all stake visuals from playervisuals here
        this.PlayerVisuals.DestroyAllStakes();
    
        // Convert all staked cells in the loop to claims
        for (const key of stakePositions) {
            const [x, y] = key.split(',').map(Number);
            this.claimSparseCell(x, y, this.playerID);
        }
    
        // Find the enclosed area, now surrounded by claimed cells and claim it
        this.findAndFillEnclosedRegion(stakePositions);
    
        print('Claim expansion complete!');
    }
    
    //wrapper function for creating world objects before passing to sparsegrid
    claimSparseCell(x: number, y: number, player: number){
        //pass in xy of grid pos and world height of y
        const worldXZ = this.gridPosToWorldCoords(x, y);
        this.PlayerVisuals.createWorldClaimVolume(1, worldXZ.x, this.currY, worldXZ.y, this.unitsPerCell);
        this.grid.claimCell(x, y, player);
    }
    
    // Step 1: Convert loop to array of segments
    getLoopEdges(loop: GridCell[]): [number, number, number, number][] {
        const edges: [number, number, number, number][] = [];
        for (let i = 0; i < loop.length; i++) {
            const [x1, y1] = loop[i].split(',').map(Number);
            const [x2, y2] = loop[(i + 1) % loop.length].split(',').map(Number);
            edges.push([x1, y1, x2, y2]);
        }
        return edges;
    }
    
    // Step 2: Check if a point is inside the loop using ray casting
    isInLoop(x: number, y: number, edges: [number, number, number, number][]): boolean {
        let count = 0;
        for (const [x1, y1, x2, y2] of edges) {
            if ((y1 > y) !== (y2 > y)) {
                const xCross = ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
                if (xCross > x) count++;
            }
        }
        return count % 2 === 1;
    }

    //main function for filling loop of cells (grid loop can be part/completely diagonal and multiple cells thick)
    findAndFillEnclosedRegion(loop: GridCell[]) {
        const loopSet = new Set(loop);
        const edges = this.getLoopEdges(loop);
    
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const key of loop) {
            const [x, y] = key.split(',').map(Number);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
    
        for (let x = minX + 1; x < maxX; x++) {
            for (let y = minY + 1; y < maxY; y++) {
                const key = `${x},${y}` as GridCell;
                if (!loopSet.has(key) && this.isInLoop(x, y, edges)) {
                    this.claimSparseCell(x, y, this.playerID);
                }
            }
        }
    
        print("Scanline region fill complete!");
    }







}


// Define possible states for a grid cell
export enum CellState {
    UNCLAIMED = "Unclaimed",
    CLAIMED = "Claimed",
    STAKED = "Staked",
}

// Define a type for the grid cell key
type GridCell = `${number},${number}`; 
type PlayerID = number | null; // Player ID is an int (get from session controller)

export class SparseGrid {
    private claimedCells: Map<GridCell, { claimOwner: PlayerID }>;
    private stakedCells: Map<GridCell, PlayerID>;
    private lengthAndWidth: number;

    constructor(gridlength: number) {
        this.claimedCells = new Map();
        this.stakedCells = new Map();
        this.lengthAndWidth = gridlength; //square grid has equal length and width
    }
    
    //getter for grid dimensions
    getSize(): number {
        return this.lengthAndWidth;
    }

    // Claim a grid cell (overwrites claimOwner, removes any stake)
    claimCell(x: number, y: number, player: number): void {
        const key: GridCell = `${x},${y}`;
        this.claimedCells.set(key, { claimOwner: player });
        this.stakedCells.delete(key); // Remove any stake when claiming
    }

    // Stake a grid cell (does NOT overwrite claim owner)
    stakeCell(x: number, y: number, player: number): void {
        const key: GridCell = `${x},${y}`;
        this.stakedCells.set(key, player);
    }

    // Check if a cell exists and get its state
    getCellState(x: number, y: number): CellState {
        const key: GridCell = `${x},${y}`;

        if (this.stakedCells.has(key)) return CellState.STAKED;
        if (this.claimedCells.has(key)) return CellState.CLAIMED;
        return CellState.UNCLAIMED;
    }
    
    isUnclaimed(x: number, y: number): boolean{
        const key: GridCell = `${x},${y}`;

        if (this.stakedCells.has(key)) return false;
        if (this.claimedCells.has(key)) return false;
        return true;
    }

    // Get the claim owner of a cell
    getClaimOwner(x: number, y: number): PlayerID {
        const key: GridCell = `${x},${y}`;
        return this.claimedCells.get(key)?.claimOwner ?? null;
    }

    // Get the stake owner of a cell
    getStakeOwner(x: number, y: number): PlayerID {
        const key: GridCell = `${x},${y}`;
        return this.stakedCells.get(key) ?? null;
    }

    // Remove a claim (reset to unclaimed)
    unclaimCell(x: number, y: number): void {
        const key: GridCell = `${x},${y}`;
        this.claimedCells.delete(key);
    }

    // Remove a stake (reset to unclaimed if there's no claim)
    unstakeCell(x: number, y: number): void {
        const key: GridCell = `${x},${y}`;
        this.stakedCells.delete(key);
    }
    
    //gets all staked cells from the player id
    getPlayerStakes(playerID: number): GridCell[] {
        return Array.from(this.stakedCells.entries())
            .filter(([_, owner]) => owner === playerID)
            .map(([cell, _]) => cell);
    }
    
    //gets all claimed cells from the player id
    getPlayerClaims(playerID: number): GridCell[] {
        return Array.from(this.claimedCells.entries())
            .filter(([_, data]) => data.claimOwner === playerID)
            .map(([cell, _]) => cell);
    }

}
