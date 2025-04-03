import { PlayerVisuals } from './PlayerVisuals';

@component
export class GridClaimer extends BaseScriptComponent {
    
    metersPerCell: number = 4;//cells are this number by this number meters
    grid: SparseGrid = new SparseGrid(); // Initialize the grid
    lat: number = 400;
    long: number = 400;
    prevlat: number = 400;
    prevlong: number = 400;
    hasPrev: boolean = false; //has prev coords
    playerID: number = 0;
    // Store world origin to convert coords to grid space
    worldOrigin: { lat: number; long: number } | null = null; 
    
    @input
    PlayerVisuals: PlayerVisuals;
    
//    onAwake() {
//    }
    
    //function called by location tracker script whenever coordinates change
    updatePos(lat : number, long : number){
        this.setCurrAndPrev(lat, long);
        print('location has been updated');
        this.PlayerVisuals.updateHUDText(lat, long, 0, 0);
        if (this.hasPrev) {
            //convert lat and long to world coords
            const worldPos = this.gpsCoordsToWorldPos(lat, long);
            //convert world coordinates to get game grid cell
            const gridPos = this.worldCoordsToGridPos(worldPos);
            //update player visuals with coords and grid pos
            //this.PlayerVisuals.updateHUDText(lat, long, gridPos.x, gridPos.y)
            //get the CellState of the grid cell
            const currState = this.grid.getCellState(gridPos.x, gridPos.y);
            
            //the state of the grid cell matters, handle interaction
            if (currState === CellState.STAKED) {
                //stake owner dies and their stakes + claims return unclaimed
                //TODO: create function to remove all stakes & claims
            }
            else if (currState === CellState.UNCLAIMED) {
                // player drops stake on unclaimed land
                this.grid.stakeCell(gridPos.x, gridPos.y, this.playerID);
            }
            else if (currState === CellState.CLAIMED) {
                const owner = this.grid.getClaimOwner(gridPos.x, gridPos.y);
                if (owner === this.playerID) {
                    // expand claim to include area encompassed by claim loop
                    this.addStakedRegionToClaim();
                }
                else {
                    //multiplayer: if the claim owner is in the entered cell, you die
                    // player drops stake on claim (that isn't theirs yet)
                    this.grid.stakeCell(gridPos.x, gridPos.y, this.playerID);
                }
            }
        }
    }
    
    //add the staked cells to claim, then claim all cells inside stake loop and claim line
    addStakedRegionToClaim(){
        print('adding staked region to claim');
        // Collect all staked cells belonging to the player
        const stakePositions = this.grid.getPlayerStakes(this.playerID);
    
        // Convert all staked cells in the loop to claims
        for (const key of stakePositions) {
            const [x, y] = key.split(',').map(Number);
            this.grid.claimCell(x, y, this.playerID);
        }
    
        // Find the enclosed area, now surrounded by claimed cells and claim it
        this.findAndFillEnclosedRegion(stakePositions);
    
        print('Claim expansion complete!');
    }
        
    // Helper function using scanline fille to find the area of ands claim the enclosed region
    //scanline fill algorithm is extremely fast and needs to be adapted for polygons    
    // Ensure `GridCell` type is properly formatted
    private formatGridCell(x: number, y: number): GridCell {
        return `${x},${y}` as GridCell;
    }
    
    //helper function to get starter grid for scanline fill algorithm
    findSeedPoint(loop: GridCell[]): GridCell | null {
        if (loop.length === 0) return null;
    
        let sumX = 0, sumY = 0;
        
        // Sum up the coordinates
        for (const cell of loop) {
            const [x, y] = cell.split(',').map(Number);
            sumX += x;
            sumY += y;
        }
    
        // Compute the approximate centroid
        const centerX = Math.round(sumX / loop.length);
        const centerY = Math.round(sumY / loop.length);
        const centroid: GridCell = `${centerX},${centerY}`;
    
        // Check if centroid is a valid seed
        if (this.isValidSeed(centroid, loop)) {
            return centroid;
        }
    
        // Otherwise, search for the nearest valid cell
        return this.findNearestValidSeed(centerX, centerY, loop);
    }
    
    isValidSeed(cell: GridCell, loop: GridCell[]): boolean {
        //it's a valid seed if not included in loop (grid cell state doesn't matter)
        return !loop.includes(cell); 
    }
    
    //helper function to get seed point for scanline fill algorithm
    findNearestValidSeed(cx: number, cy: number, loop: GridCell[]): GridCell | null {
        const directions = [
            [0, 1], [1, 0], [0, -1], [-1, 0], // Cardinal directions
        ];
    
        const queue: GridCell[] = [`${cx},${cy}`];
        const visited = new Set(queue);
    
        while (queue.length > 0) {
            const current = queue.shift()!;
            const [x, y] = current.split(',').map(Number);
    
            if (this.isValidSeed(current, loop)) {
                return current; // Found a valid seed point
            }
    
            for (const [dx, dy] of directions) {
                const neighbor: GridCell = `${x + dx},${y + dy}`;
                if (!visited.has(neighbor)) {
                    queue.push(neighbor);
                    visited.add(neighbor);
                }
            }
        }
    
        return null; // No valid seed found (unlikely)
    }


    //main function for scanline fill algorithm, takes in loop of cells
    findAndFillEnclosedRegion(loop: GridCell[]) {
        const visited = new Set<GridCell>(); // Track visited cells
        const queue: GridCell[] = [];
    
        // Convert loop to a set for fast boundary checking
        const loopSet = new Set(loop);
    
        // Step 1: Find a seed point inside the loop
        const seed = this.findSeedPoint(loop);
        if (!seed) return;
    
        queue.push(seed);
        visited.add(seed);
    
        while (queue.length > 0) {
            const current = queue.shift()!;
            const [x, y] = current.split(',').map(Number);
    
            // Step 2: Scan right and left
            let left = x;
            while (!loopSet.has(this.formatGridCell(left - 1, y)) && !visited.has(this.formatGridCell(left - 1, y))) {
                left--;
            }
            let right = x;
            while (!loopSet.has(this.formatGridCell(right + 1, y)) && !visited.has(this.formatGridCell(right + 1, y))) {
                right++;
            }
    
            // Step 3: Claim the entire horizontal span
            for (let fillX = left; fillX <= right; fillX++) {
                this.grid.claimCell(fillX, y, this.playerID);
                const cellKey = this.formatGridCell(fillX, y);
                visited.add(cellKey);
    
                // Step 4: Add neighbors (up and down) if not yet visited or outside boundary
                if (!loopSet.has(this.formatGridCell(fillX, y - 1)) && !visited.has(this.formatGridCell(fillX, y - 1))) {
                    queue.push(this.formatGridCell(fillX, y - 1));
                }
                if (!loopSet.has(this.formatGridCell(fillX, y + 1)) && !visited.has(this.formatGridCell(fillX, y + 1))) {
                    queue.push(this.formatGridCell(fillX, y + 1));
                }
            }
        }
    }


    
    
    //converts the world coords to grid row and column number
    worldCoordsToGridPos(wPos: vec2): vec2{
        //divide the meters away from origin by meters per cell
        //this gets the cells away from origin to determine grid pos
        const row = wPos.x / this.metersPerCell;
        const col = wPos.y / this.metersPerCell;
        return new vec2(row, col);
    }
    
    //function to determine where player is in world space from their gps coords
    gpsCoordsToWorldPos(lat: number, long: number): vec2{
        // Define conversion factors (every five decimal points difference is ~1 meter)
        const metersPerLat = 111320; // 1 degree latitude ≈ 111.32 km (constant)
        const metersPerLong = Math.cos(lat * Math.PI / 180) * 111320; 
        // Longitude conversion depends on latitude
    
        // Convert lat/lon difference to meters
        const latMeterDiff = (this.worldOrigin.lat - lat) * metersPerLat;
        const longMeterDiff = (this.worldOrigin.long - long) * metersPerLong;
        //return vec2 of world pos difference between origin and coords
        return new vec2(longMeterDiff, latMeterDiff);
    }
    
    //updates the lat, long, prevlat, prevlong
    setCurrAndPrev(lat: number, long: number) {
        if (!this.hasPrev) {
            if (this.lat === 400) {
                // First call: Initialize current position
                this.lat = lat;
                this.long = long;
                //create grid on start
                this.createInitialGrid(); // Create the grid when the world origin is set
                //TODO: create home claim on start
                //set world origin for all in lens instance to base location on
                if (!this.worldOrigin) {
                    this.worldOrigin = { lat: this.lat, long: this.long };
                }
                return;
            }
            // Second call: Set previous position and world origin
            this.prevlat = this.lat;
            this.prevlong = this.long;
            this.hasPrev = true;
        } else {
            // 3rd+ call: Shift current to previous and update new position
            this.prevlat = this.lat;
            this.prevlong = this.long;
        }
        // Always update the current position
        this.lat = lat;
        this.long = long;
    }
    
    //function to create big unclaimed grid around player
    createInitialGrid() {
        const gridRadius = 10; // Create a 10x10 grid area around the player
        for (let x = -gridRadius; x <= gridRadius; x++) {
            for (let y = -gridRadius; y <= gridRadius; y++) {
                this.grid.unclaimCell(x, y); // Initialize all cells as unclaimed
            }
        }
        print("Grid initialized.");
    }
}


// Define possible states for a grid cell
enum CellState {
    UNCLAIMED = "Unclaimed",
    CLAIMED = "Claimed",
    STAKED = "Staked",
}

// Define a type for the grid cell key
type GridCell = `${number},${number}`; 
type PlayerID = number | null; // Player ID is an int (get from session controller)

class SparseGrid {
    private claimedCells: Map<GridCell, { claimOwner: PlayerID }>;
    private stakedCells: Map<GridCell, PlayerID>;

    constructor() {
        this.claimedCells = new Map();
        this.stakedCells = new Map();
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
}
