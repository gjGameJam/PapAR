@component
export class GridClaimer extends BaseScriptComponent {
    
    lat: number = 0;
    long: number = 0;
    prevlat: number = 0;
    prevlong: number = 0;
    
    onAwake() {

    }
    
    //function called by location tracker script whenever coordinates change
    updatePos(lat : number, long : number){
        print('location has been updated');
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
    private claimedCells: Map<GridCell, { state: CellState; player: PlayerID }>;

    constructor() {
        this.claimedCells = new Map();
    }

    // Claim a grid cell
    claimCell(x: number, y: number, player: number): void {
        const key: GridCell = `${x},${y}`;
        this.claimedCells.set(key, { state: CellState.CLAIMED, player });
    }

    // Stake a grid cell
    stakeCell(x: number, y: number, player: number): void {
        const key: GridCell = `${x},${y}`;
        this.claimedCells.set(key, { state: CellState.STAKED, player });
    }

    // Check if a cell exists and get its state
    getCellState(x: number, y: number): CellState {
        const key: GridCell = `${x},${y}`;
        return this.claimedCells.get(key)?.state ?? CellState.UNCLAIMED;
    }

    // Get the owner of a cell
    getOwner(x: number, y: number): PlayerID {
        const key: GridCell = `${x},${y}`;
        return this.claimedCells.get(key)?.player ?? null;
    }

    // Remove a claim or stake (reset to unclaimed)
    unclaimCell(x: number, y: number): void {
        const key: GridCell = `${x},${y}`;
        this.claimedCells.delete(key);
    }
}


