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
    
    @input
    cell00: Image;
    
    @input
    cell01: Image;
    
    @input
    cell02: Image;
    
    @input
    cell03: Image;
    
    @input
    cell04: Image;
    
    @input
    cell10: Image;
    
    @input
    cell11: Image;
    
    @input
    cell12: Image;
    
    @input
    cell13: Image;
    
    @input
    cell14: Image;
    
    @input
    cell20: Image;
    
    @input
    cell21: Image;
    
    @input
    cell22: Image;
    
    @input
    cell23: Image;
    
    @input
    cell24: Image;
    
    @input
    cell30: Image;
    
    @input
    cell31: Image;
    
    @input
    cell32: Image;
    
    @input
    cell33: Image;
    
    @input
    cell34: Image;
    
    @input
    cell40: Image;
    
    @input
    cell41: Image;
    
    @input
    cell42: Image;
    
    @input
    cell43: Image;
    
    @input
    cell44: Image;
    
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
        const miniMapRadius = 2; // minimap is 5x5 (center + 2 in each direction)
    
        // Loop through a 5x5 window centered around player
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
        //TODO: color correct cell given pos and color
        const imgName = `cell${gridX}${gridY}`;
        const img = this[imgName];
        if (img && img.mainPass) {
            // If this image doesn't already have its own material, clone it
            if (!img.__hasUniqueMaterial) {
                const clonedMat = img.mainMaterial.clone();
                img.mainMaterial = clonedMat;
                img.__hasUniqueMaterial = true;
            }
            img.mainPass.baseColor = color; // assuming `color` is already a vec4
        } else {
            print(`MiniMap cell "${imgName}" does not exist.`);
        }
        //this[imgName].mainPass.baseColor = new vec4(255, 0, 0, 1.0);
    }
    
    //helper function to get color of cell based on cellstate (null/OOB is gray, staked is transparent green, and claimed is green)
    getCellColor(cellState: CellState | null): vec4 {
        if (cellState == null) return new vec4(255, 0, 0, 1.0); // boundary / out of bounds
        switch (cellState) {
            case CellState.UNCLAIMED: return new vec4(0, 0, 255, .75); // white
            case CellState.CLAIMED:   return new vec4(0, 255, 0, .75); // green
            case CellState.STAKED:   return new vec4(0, 255, 0, 0.25);     // translucent green
            default: return new vec4(128, 128, 128, 1.0); // fallback gray
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
