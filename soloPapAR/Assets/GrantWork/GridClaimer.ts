import { PlayerVisuals } from './PlayerVisuals';

@component
export class GridClaimer extends BaseScriptComponent {
    
    unitsPerCell: number = 200;//cells are this number by this number meters
    gridRadius: number = 20;
    grid: SparseGrid = new SparseGrid(this.gridRadius * 2); // Initialize the grid as gridDiameter * gridDiameter
    currX: number = 400;
    currY: number = 400;
    prevX: number = 400;
    prevY: number = 400;
    hasPrev: boolean = false; //has prev coords
    playerID: number = 0;
    DEGREES_TO_RADIANS = Math.PI / 180;
    
    @input
    PlayerVisuals: PlayerVisuals;

    
    //function called by location tracker script whenever coordinates change
    updatePos(worldX : number, worldZ : number){
        //print('location has been updated');
        this.setCurrAndPrev(worldX, worldZ);
        
        //if (this.hasPrev) {
        //convert world coordinates to get game grid cell
        const gridPos = this.worldCoordsToGridPos(new vec2(worldX, worldZ));
            
        //TODO: remove debugging update player visuals with coords and grid pos
        this.PlayerVisuals.updateHUDText(gridPos.x, gridPos.y, worldX, worldZ, 0, 0);
            
        //return early if player is in same grid as last updatePos call
        if (this.PlayerVisuals.isInSameCell(gridPos)){
            return; 
        }
            
        //get the CellState of the grid cell
        const currState = this.grid.getCellState(gridPos.x, gridPos.y);
            
        //the state of the grid cell matters, handle interaction
        if (currState === CellState.STAKED) {
            //stake owner dies and their stakes + claims return unclaimed
            //TODO: create function to remove all stakes & claims
            print('player hit their own stake');
            this.handlePlayerDeath(this.playerID);
        }
        else if (currState === CellState.UNCLAIMED) {
            // player drops stake on unclaimed land
            this.grid.stakeCell(gridPos.x, gridPos.y, this.playerID);
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
        
        const GridPos = this.worldCoordsToGridPos(new vec2(this.currX, this.currY));
        //world origin is device handler's (0,0,0)
        this.grid.claimCell(GridPos.x, GridPos.y, deadPlayerID);
        
        
    }
    
    //converts the world coords to grid row and column number
    worldCoordsToGridPos(wPos: vec2): vec2 {
        //get half of cell
        const halfCell = this.unitsPerCell / 2;
        //make player spawn (origin) in center of cell
        const xOffset = wPos.x + halfCell;
        const yOffset = wPos.y + halfCell;
        // The center of the grid corresponds to (gridRadius, gridRadius)
        //so consider 0,0,0 to be center of grid, add offset to be in center of cell, then divide by cells to determine which cell to be in
        const col = Math.floor(this.gridRadius + (xOffset / this.unitsPerCell));
        const row = Math.floor(this.gridRadius + (yOffset / this.unitsPerCell));
    
        return new vec2(col, row);
    }
    
    //updates the current and previous world pos x and z (we dont care about y)
    setCurrAndPrev(newX: number, newY: number) {
        if (!this.hasPrev) {
            if (this.currX === 400) {
                // First call: Initialize current position
                this.currX = newX;
                this.currY = newY;
                //create grid on start
                this.createInitialGrid(); // Create the grid when the world origin is set
                //TODO: create home claim on start
                const GridPos = this.worldCoordsToGridPos(new vec2(this.currX, this.currY));
                //world origin is device handler's (0,0,0)
                this.grid.claimCell(GridPos.x, GridPos.y, this.playerID);
                print('player claimed home region');
                return;
            }
            // Second call: Set previous position
            this.prevX = this.currX;
            this.prevY = this.currY;
            this.hasPrev = true;
        } else {
            // 3rd+ call: Shift current to previous and update new position
            this.prevX = this.currX;
            this.prevY = this.currY;
        }
        // Always update the current position
        this.currX = newX;
        this.currY = newY;
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
            print('no staked region to add to claim');
            return;
        }
        print('adding staked region to claim');
    
        // Convert all staked cells in the loop to claims
        for (const key of stakePositions) {
            const [x, y] = key.split(',').map(Number);
            this.grid.claimCell(x, y, this.playerID);
        }
    
        // Find the enclosed area, now surrounded by claimed cells and claim it
        this.findAndFillEnclosedRegion(stakePositions);
    
        print('Claim expansion complete!');
    }


    //main function for scanline fill algorithm, takes in loop of cells
    findAndFillEnclosedRegion(loop: GridCell[]) {
        const visited = new Set<string>();
        const queue: GridCell[] = [];
    
        // Step 1: Bounding box of the loop
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const key of loop) {
            const [x, y] = key.split(',').map(Number);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
    
        // Step 2: Try to find a fill start point inside the bounding box
        let found = false;
        for (let x = minX + 1; x < maxX && !found; x++) {
            for (let y = minY + 1; y < maxY && !found; y++) {
                const key = `${x},${y}` as GridCell;
                if (this.grid.isUnclaimed(x, y)) {
                    queue.push(key);
                    visited.add(key);
                    found = true;
                }
            }
        }
    
        if (!found) {
            print("No valid fill start point found.");
            return;
        }
    
        // Step 3: Flood fill in 8 directions
        const directions = [
            [1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [-1, -1], [-1, 1], [1, -1]
        ];
    
        while (queue.length > 0) {
            const cell = queue.shift();
            const [x, y] = cell.split(',').map(Number);
    
            this.grid.claimCell(x, y, this.playerID); // Claim the cell
    
            for (const [dx, dy] of directions) {
                const nx = x + dx;
                const ny = y + dy;
                const key = `${nx},${ny}` as GridCell;;
    
                if (
                    nx >= minX && nx <= maxX &&
                    ny >= minY && ny <= maxY &&
                    !visited.has(key) &&
                    this.grid.isUnclaimed(nx, ny)
                ) {
                    visited.add(key);
                    queue.push(key);
                }
            }
        }
    
        print("8-directional fill complete!");
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
