
@component
export class LoopDetection extends BaseScriptComponent {
    
//    // Define a constant for the maximum number of vertices
//    private static MAX_VERTEX: number = 101;
//
//    // Arrays to represent parent and size of each node
//    private Arr: number[] = Array(LoopDetection.MAX_VERTEX).fill(0);
//    private size: number[] = Array(LoopDetection.MAX_VERTEX).fill(0);
//    
//    // Initialize the Union-Find structure
//    initialize(n: number): void {
//        for (let i = 0; i <= n; i++) {
//            this.Arr[i] = i;
//            this.size[i] = 1;
//        }
//    }
//
//    // Path compression find function
//    private find(i: number): number {
//        // While we haven't reached the root
//        while (this.Arr[i] !== i) {
//            this.Arr[i] = this.Arr[this.Arr[i]]; // Path compression
//            i = this.Arr[i]; // Move to the next level
//        }
//        return i;
//    }
//
//    // Union function to connect two sets
//    private _union(xr: number, yr: number): void {
//        if (this.size[xr] < this.size[yr]) {
//            // Make yr parent of xr
//            this.Arr[xr] = this.Arr[yr];
//            this.size[yr] += this.size[xr];
//        } else {
//            // Make xr parent of yr
//            this.Arr[yr] = this.Arr[xr];
//            this.size[xr] += this.size[yr];
//        }
//    }
//
//    // Main function to check for cycles in a graph
//    isCycle(adj: number[][], V: number): number {
//        // Initialize the Union-Find structure for the graph
//        this.initialize(V);
//
//        // Iterate through all edges of the graph
//        for (let i = 0; i < V; i++) {
//            for (let j = 0; j < adj[i].length; j++) {
//                const x: number = this.find(i); // Find root of i
//                const y: number = this.find(adj[i][j]); // Find root of adj[i][j]
//
//                if (x === y) {
//                    return 1; // If same parent, cycle detected
//                }
//                this._union(x, y); // Union the sets
//            }
//        }
//        return 0; // No cycle detected
//    }
//    
//    //main conversion function to get adjacency list from stake line
//    convertToAdjacencyList(stakes: GridCell[], gridRows: number, gridCols: number): Map<GridCell, GridCell[]> {
//        const adjacencyList: Map<GridCell, GridCell[]> = new Map();
//    
//        // Direction vectors for 4-connectivity (left, right, up, down)
//        const directions: number[][] = [
//            [0, -1], // left
//            [0, 1],  // right
//            [-1, 0], // up
//            [1, 0]   // down
//        ];
//    
//        // Iterate over each stake to find its neighbors
//        stakes.forEach((cell) => {
//            const [row, col] = cell.split(',').map(Number);
//            const neighbors: GridCell[] = [];
//    
//            // Check all four possible directions
//            directions.forEach(([dRow, dCol]) => {
//                const neighborRow = row + dRow;
//                const neighborCol = col + dCol;
//    
//                // Check if the neighbor is within grid bounds
//                if (neighborRow >= 0 && neighborRow < gridRows && neighborCol >= 0 && neighborCol < gridCols) {
//                    const neighborCell = `${neighborRow},${neighborCol}`;
//                    if (stakes.includes(neighborCell)) {
//                        neighbors.push(neighborCell);
//                    }
//                }
//            });
//    
//            // Map the current cell to its list of neighbors
//            adjacencyList.set(cell, neighbors);
//        });
//    
//        return adjacencyList;
//    }
//    
//    
    
}


//type GridCell = `${number},${number}`; 

//// Example usage
//const loopDetection = new LoopDetection();
//
//// Graph example with adjacency list (0-based indexing)
//const adj: number[][] = [
//    [1, 2],  // Node 0 connects to nodes 1 and 2
//    [0, 3],  // Node 1 connects to nodes 0 and 3
//    [0],      // Node 2 connects to node 0
//    [1]       // Node 3 connects to node 1
//];
//const V: number = 4;  // Number of vertices
//
//const cycle: number = loopDetection.isCycle(adj, V); // Check for cycle in the graph
//console.log(cycle ? "Cycle detected" : "No cycle detected");
