import { LoopDetection } from './UnionFindLoopDetection';

@component
export class GridClaimer extends BaseScriptComponent {
    
    metersPerCell: number = 4;//cells are this number by this number meters
    grid: SparseGrid = new SparseGrid(); // Initialize the grid
    loopDetection: LoopDetection = new LoopDetection(); // Initialize the loop detection algorithm
    lat: number = 400;
    long: number = 400;
    prevlat: number = 400;
    prevlong: number = 400;
    hasPrev: boolean = false; //has prev coords
    playerID: number = 0;
    // Store world origin to convert coords to grid space
    worldOrigin: { lat: number; long: number } | null = null; 
    
    @input
    LoopDetection: LoopDetection;
    
//    onAwake() {
//    }
    
    //function called by location tracker script whenever coordinates change
    updatePos(lat : number, long : number){
        this.setCurrAndPrev(lat, long);
        print('location has been updated');
        if (this.hasPrev) {
            //convert lat and long to world coords
            const worldPos = this.gpsCoordsToWorldPos(lat, long);
            //convert world coordinates to get game grid cell
            const gridPos = this.worldCoordsToGridPos(worldPos);
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
        const playerStakes = this.grid.getPlayerStakes(this.playerID);
        // Attempt to find a closed loop of the player stakes
        const closedLoop = this.findClosedLoop(playerStakes);
        if (!closedLoop) {
            print('No closed loop detected.');
            return;
        }
    
        // Convert all staked cells in the loop to claims
        for (const key of closedLoop) {
            const [x, y] = key.split(',').map(Number);
            this.grid.claimCell(x, y, this.playerID);
        }
    
        // Find the enclosed area and claim it
        this.findAndFillEnclosedRegion(closedLoop);
    
        print('Claim expansion complete!');
    }
    
    
    //converts the world coords to grid row and column number
    worldCoordsToGridPos(wPos: vec2): vec2{
        //divide the meters away from origin by meters per cell
        //this gets the cells away from origin to determine grid pos
        const row = wPos.x / this.metersPerCell;
        const col = wPos.y / this.metersPerCell;
        return new vec2(row, col);
    }
    
    // Helper function to detect a closed loop of stakes
    findClosedLoop(stakes: GridCell[]): GridCell[] | null {
        // TODO: Implement a loop detection algorithm (e.g., BFS/DFS or convex hull method)
        // If a closed loop is found, return the ordered list of stakes forming the loop.
        return null;
    }
    
    // Helper function to find the area of ands claim the enclosed region
    findAndFillEnclosedRegion(loop: GridCell[]) {
        // TODO: Implement a flood-fill algorithm or polygon scanline fill
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
                //TODO: create grid on start
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
