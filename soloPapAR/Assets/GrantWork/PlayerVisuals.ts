import { SparseGrid } from './GridClaimer';
import { CellState } from './GridClaimer';

@component
export class PlayerVisuals extends BaseScriptComponent {
    
    @input
    uiText: Text; // Reference to the Text UI component
    
    @input 
    screenTransform: ScreenTransform; //reference to screen to render minimap on
    
    prevGridPos: vec2 = new vec2(0, 0); //previous grid (only update minimap if new != previous)
    
    //@input 
    miniMapUICell: ObjectPrefab; //TODO create prefab for mini map cell
    
    //on awake, initialize all mini map cells as ui elements
    onAwake() {
        //TODO: create ui box prefab on start
        //TODO: once single box is working, go to 7x7
        //make sure cells are indexed [0-6][0-6] for draw calls (could handle in prefab?)
    }
    
    //function to create and return mini map cell prefab
    createUICellFromPrefab() {
      if (this.miniMapUICell) {
        var instanceObject = this.miniMapUICell.instantiate(this.getSceneObject());
        return instanceObject;
      } else {
        return undefined;
      }
    }
    
    //returns true if grid pos is different from last grid pos
    //Renders all minimap cells based on inidividual states (e.g., empty, stake, claim)
    updateMiniMap(gridPos: vec2, grid: SparseGrid): boolean {
        if (gridPos.equal(this.prevGridPos)) {
            return false; // don't need to update if no movement occurred (change in multiplayer version)
        }
    
        this.prevGridPos = gridPos; // update previous grid pos to current
    
        const gridLength = grid.getSize();
        const miniMapRadius = 3; // minimap is 7x7 (center + 3 in each direction)
    
        // Loop through a 7x7 window centered around player
        for (let dx = -miniMapRadius; dx <= miniMapRadius; dx++) {
            for (let dy = -miniMapRadius; dy <= miniMapRadius; dy++) {
                const gridX = gridPos.x + dx;
                const gridY = gridPos.y + dy;
    
                // These are the minimap canvas coordinates (0-6)
                const miniMapX = dx + miniMapRadius;
                const miniMapY = dy + miniMapRadius;
    
                if (gridX >= 0 && gridX < gridLength && gridY >= 0 && gridY < gridLength) {
                    const cellState = grid.getCellState(gridX, gridY);
                    this.renderMiniMapCell(miniMapX, miniMapY, cellState);
                } else {
                    this.renderMiniMapCell(miniMapX, miniMapY, null); // Out of bounds = boundary
                }
            }
        }
    
        return true; // minimap was updated
    }

    
    //main helper function for coloring the cells of the mini map
    renderMiniMapCell(gridX: number, gridY: number, cellState: CellState | null): void {
        //get color of cell to draw via cellstate
        const color = this.getCellColor(cellState);
        //TODO: get prefab and color from array
//        let cell = minimapCells[gridX][gridY];
//        let image = cell.getComponent("Component.Image"); //get image component
//        image.mainPass.baseColor = color;
    }
    
    //helper function to get color of cell based on cellstate (null/OOB is gray, staked is transparent green, and claimed is green)
    getCellColor(cellState: CellState | null): string {
        if (cellState == null) return "rgba(128, 128, 128, 1.0)"; // boundary / out of bounds
        switch (cellState) {
            case CellState.UNCLAIMED: return "rgba(255, 255, 255, 1.0)"; // white
            case CellState.CLAIMED:   return "rgba(0, 255, 0, 1.0)";     // solid green
            case CellState.STAKED:   return "rgba(0, 255, 0, 0.4)";     // translucent green
            default: return "rgba(128, 128, 128, 1.0)"; // fallback gray
        }
    }

    
    //function to display info as text on screen
    //this is called by grid claimer in update pos
    updateHUDText(lat: number, long: number, gridx: number, gridy: number, latOff: number, longOff: number): void {
        // Clamp latitude and longitude to 5 decimal places
        const clampedLat = lat.toFixed(5);
        const clampedLong = long.toFixed(5);
        const clampedgridx = gridx.toFixed(5);
        const clampedgridy = gridy.toFixed(5);
        const clampedlatOff = latOff.toFixed(5);
        const clampedlongOff = longOff.toFixed(5);
    
        print('HUD text has been updated');
        // Display the clamped coordinates and grid position
        this.uiText.text = 
            `Offset: (${clampedLat}, ${clampedLong})\n` + 
            `WorldPos: (${clampedgridx}, ${clampedgridy})\n` + 
            `Grid Cell: (${clampedlatOff}, ${clampedlongOff})`;
    }
}
