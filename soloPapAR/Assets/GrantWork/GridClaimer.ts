@component
export class GridClaimer extends BaseScriptComponent {
    
    lat: number = 400;
    long: number = 400;
    prevlat: number = 400;
    prevlong: number = 400;
    hasPrev: boolean = false; //has prev coords
    
    onAwake() {

    }
    
    //function called by location tracker script whenever coordinates change
    updatePos(lat : number, long : number){
        print('location has been updated');
        this.setCurrAndPrev(lat, long);
        //if lat, long, prevlat, and prevlong are set, 
        //check for collision with stake line, if so kill the owning player
        //either stake when out of claim or do nothing when in claim
        if (this.hasPrev) {
            //convert lat and long to world coords
            //determine which grid cell world coords are in
            //get the CellState of the grid cell
            //if CellState == Staked, stake owner dies and their stakes + claims return unclaimed
            //if CellState == Claimed, player drops stake on claim
        }
    }
    
    //updates the lat, long, prevlat, prevlong
    setCurrAndPrev(lat: number, long: number) {
        if (!this.hasPrev) {
            if (this.lat === 400) {
                // First call: Initialize current position
                this.lat = lat;
                this.long = long;
                return;
            }
            // Second call: Set previous position
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
}

