import { SparseGrid } from './GridClaimer';
import { CellState } from './GridClaimer';
import { LocationTracker } from './LocationTracker';
import {Instantiator} from '../../SpectaclesSyncKit/Components/Instantiator';

@component
export class PlayerVisuals extends BaseScriptComponent {
    
    @input
    uiText: Text; // Reference to the Text UI component
    
    @input 
    screenTransform: ScreenTransform; //reference to screen to render minimap on
    
    prevGridPos: vec2 = new vec2(0, 0); //previous grid (only update minimap if new != previous)
    
    @input
    cellMaterial: Material;
        
    @input
    whiteCell: Texture;
    
    @input
    playerArrow: ScreenTransform;
    
    @input
    deviceTracker: LocationTracker;
    
    //player 1 visual objects
    @input
    p1claimCellObj: ObjectPrefab;
    
    @input
    p1stakeCellObj: ObjectPrefab;
    
    @input
    p1stakePillarObj: ObjectPrefab;
    
    //player 2 visual objects
    @input
    p2claimCellObj: ObjectPrefab;
    
    @input
    p2stakeCellObj: ObjectPrefab;
    
    @input
    p2stakePillarObj: ObjectPrefab;
    
    //player 3 visual objects
    @input
    p3claimCellObj: ObjectPrefab;
    
    @input
    p3stakeCellObj: ObjectPrefab;
    
    @input
    p3stakePillarObj: ObjectPrefab;
    
    //player 4 visual objects
    @input
    p4claimCellObj: ObjectPrefab;
    
    @input
    p4stakeCellObj: ObjectPrefab;
    
    @input
    p4stakePillarObj: ObjectPrefab;
    
    //player 5 visual objects
    @input
    p5claimCellObj: ObjectPrefab;
    
    @input
    p5stakeCellObj: ObjectPrefab;
    
    @input
    p5stakePillarObj: ObjectPrefab;
    
    //end of player object fields
    
    @input
    networkedInstantiator: Instantiator;
    
    //array of cells going one column at a time
    @input
    miniMapCells: Image[]; // array of cells to be colored for minimap
   
    // Global array to hold all instances of claims
    spawnedClaims: SceneObject[] = [];
    
    // Global array to hold all instances of stakes 
    spawnedStakes: SceneObject[] = [];
    
    private previousRotation: number = 0;
    
    
    //returns true if new worldPos == previous position
    isInSameCell(gridPos: vec2): boolean{
        if (gridPos.equal(this.prevGridPos)){
            return true;
        }
        this.prevGridPos = gridPos; // update previous grid pos to current
        return false;
    }
    
    //gets the stake pillar associated with the specified player ID
    getStakePillarFromPlayerID(ID: number): ObjectPrefab{
        switch (ID){
            case 1: //player 1
            return this.p1stakePillarObj;
            
            case 2: //player 2
            return this.p2stakePillarObj;
            
            case 3: //player 3
            return this.p3stakePillarObj;
            
            case 4: //player 4
            return this.p4stakePillarObj;
            
            case 5: //player 5
            return this.p5stakePillarObj;
            
            default: //when no player ids matching up to switch cases is passed, return null
            return null;
        }
        
    }
    
    //gets the stake cell volume associated with the specified player ID
    getStakeVolumeFromPlayerID(ID: number): ObjectPrefab{
        switch (ID){
            case 1: //player 1
            return this.p1stakeCellObj;
            
            case 2: //player 2
            return this.p2stakeCellObj;
            
            case 3: //player 3
            return this.p3stakeCellObj;
            
            case 4: //player 4
            return this.p4stakeCellObj;
            
            case 5: //player 5
            return this.p5stakeCellObj;
            
            default: //when no player ids matching up to switch cases is passed, return null
            return null;
        }
        
    }
    
    //gets the claim cell volume associated with the specified player ID
    getClaimVolumeFromPlayerID(ID: number): ObjectPrefab{
        switch (ID){
            case 1: //player 1
            return this.p1claimCellObj;
            
            case 2: //player 2
            return this.p2claimCellObj;
            
            case 3: //player 3
            return this.p3claimCellObj;
            
            case 4: //player 4
            return this.p4claimCellObj;
            
            case 5: //player 5
            return this.p5claimCellObj;
            
            default: //when no player ids matching up to switch cases is passed, return null
            return null;
        }
        
    }
    
    //creates a cell cube visual for claimed cell via instantiator.instantiate
    createWorldClaimVolume(ID: number, x: number, y: number, z: number, scale: number){
        //return early if networked instantiator is not ready
        if (!this.networkedInstantiator.isReady()){
            print('instantiator not ready:(');
            return;
        }
        //use y passed in but convert x and z (grid pos) to world pos
        //move down a little bit in y to account for the fact that device is at head level (want to spawn cubes at body)
        var newPosition = new vec3(x, y - (scale / 6), z);
        
        //spawn the cell via the instantiator
        this.networkedInstantiator.instantiate(this.getClaimVolumeFromPlayerID(ID), undefined, (networkRoot) => {
          const cellObject = networkRoot.sceneObject;
          //set appropriate position
          cellObject.getTransform().setLocalPosition(newPosition);
          //set scale
          var cellScale = new vec3(scale, scale, scale);
          cellObject.getTransform().setLocalScale(cellScale);
          //push volume (might need to network differently)
          this.spawnedClaims.push(cellObject);
        });
    }
    
    
    //creates cube visuals for staked cell via instantiator.instantiate
    createWorldStakeVolume(ID: number, x: number, y: number, z: number, scale: number){
        //return early if networked instantiator is not ready
        if (!this.networkedInstantiator.isReady()){
            print('instantiator not ready:(');
            return;
        }
        //use y passed in but convert x and z (grid pos) to world pos
        //move down a little bit in y to account for the fact that device is at head level (want to spawn cubes at body)
        var newPosition = new vec3(x, y - (scale / 6), z);        
        
        //spawn the cell via the instantiator
        this.networkedInstantiator.instantiate(this.getStakeVolumeFromPlayerID(ID), undefined, (networkRoot) => {
          const cellObject = networkRoot.sceneObject;
          //set appropriate position
          cellObject.getTransform().setLocalPosition(newPosition);
          //set scale
          var cellScale = new vec3(scale, scale, scale);
          cellObject.getTransform().setLocalScale(cellScale);
          //push volume (might need to network differently)
          this.spawnedStakes.push(cellObject);
        });
        
        //spawn the pillar via the instantiator
        this.networkedInstantiator.instantiate(this.getStakePillarFromPlayerID(ID), undefined, (networkRoot) => {
          const stakeObject = networkRoot.sceneObject;
          //set appropriate position
          stakeObject.getTransform().setLocalPosition(newPosition);
          //set scale
          var pillarScale = new vec3(1, scale, 1);
          stakeObject.getTransform().setLocalScale(pillarScale);
          //push prefab (might need to network differently)
          this.spawnedStakes.push(stakeObject);
        });
        
    }
    
    //destroy all visible color volumes representing home claims
    DestroyAllClaims(){
        //destroyall claims
        for (let obj of this.spawnedClaims) {
            if (obj && obj.destroy) {
                obj.destroy();
            }
        }
        //set length to 0 to be reused
        this.spawnedClaims.length = 0;
        print('removed all home claims');
    }
    
    //destroy all visible color volumes representing staked cells
    DestroyAllStakes(){
        //destroy all stakes
        for (let obj of this.spawnedStakes) {
            if (obj && obj.destroy) {
                obj.destroy();
            }
        }
        //set length to 0 to be reused
        this.spawnedStakes.length = 0;
        print('removed all stakes');
    }
   
    onAwake(){
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
        // change scale of player direction arrow if needed
        //let arrowTransform = this.playerArrow.getTransform();
        //const scale = arrowTransform.getLocalScale();
        //arrowTransform.setLocalScale(new vec3(scale.x, scale.y, scale.z));
    }
    
    onUpdate() {
        // get radians rotation in z
        const yawRadians = this.deviceTracker.getDeviceTrackerRotation();
        //update arrow if new rotation is found
        if (this.previousRotation != yawRadians){
            // update the player arrow with appropriate rotation
            this.rotatePlayerArrow(yawRadians);
        }
        
    }
    
    //main function to adjust player direction facing arrow given rotation
    rotatePlayerArrow(yawRads: number){
        const yawDegrees = (yawRads * 180) / Math.PI;
        //print('rotating arrow: ' + yawDegrees);
        // Access the transform component of the playerArrow img
        let arrowTransform = this.playerArrow.getTransform();
        const adjustedRads = -yawRads + (Math.PI / 2);
        let rotationQuat = quat.fromEulerAngles(0, 0, adjustedRads);
        
        // Set the rotation of the transform component
        arrowTransform.setLocalRotation(rotationQuat);
        //arrowTransform.setLocalRotation(quat.angleAxis(yawDegrees, vec3.back()));
    }
    
    //Renders all minimap cells based on inidividual states (e.g., empty, stake, claim)
    updateMiniMap(gridPos: vec2, grid: SparseGrid) {

        const gridLength = grid.getSize();
        const miniMapRadius = 2; // minimap is 5x5 (center + 2 in each direction)
    
        // Loop through a 5x5 window centered around player
        for (let dx = -miniMapRadius; dx <= miniMapRadius; dx++) {
            for (let dy = -miniMapRadius; dy <= miniMapRadius; dy++) {
                //this will go from your pos +- 2
                const gridX = gridPos.x + dx;
                const gridY = gridPos.y + dy;
    
                // These are the minimap canvas coordinates (0-4)
                const miniMapX = dx + miniMapRadius;
                const miniMapY = dy + miniMapRadius;
                
                //if gridx and gridy are within bounds, draw cellstate else draw red
                if (gridX >= 0 && gridX < gridLength && gridY >= 0 && gridY < gridLength) {
                    //gets and renders the cell state
                    const cellState = grid.getCellState(gridX, gridY);
                    //print('x: ' + gridX + ', y: ' + gridY + ', state: ' + cellState);
                    this.renderMiniMapCell(miniMapX, miniMapY, cellState);
                } else {
                    //renders null cell state
                    this.renderMiniMapCell(miniMapX, miniMapY, null); // Out of bounds = boundary
                    //print('x: ' + gridX + ', y: ' + gridY + ', is out of bounds?');
                }
            }
        }
        
    
    }
    
    //helper function to clone cellMaterial
    getCellMatClone(){
        return this.cellMaterial.clone();
    }
    
    //creates cell image ui attached to screen transform
    createUICell(localPos: vec3) {
        // 1. Create SceneObject
        const cellObj = global.scene.createSceneObject("CellObject");
        if (!cellObj) {
            print("Failed to create CellObject scene object.");
            return;
        }
    
        // 2. Parent it to the screen transform’s scene object
        const parentObj = this.screenTransform.getSceneObject();
        if (!parentObj) {
            print("screenTransform's SceneObject is null.");
            return;
        }
        cellObj.setParent(parentObj);
    
        // 3. Add a ScreenTransform for UI positioning
        const transform = cellObj.createComponent("Component.ScreenTransform");
        if (!transform) {
            print("Failed to create ScreenTransform on CellObject.");
            return;
        }
    
        // 4. Add the Image component
        const newImage = cellObj.createComponent("Component.Image");
        if (!newImage) {
            print("Failed to create Image component on CellObject.");
            return;
        }
    
        // 5. Clone the material and assign
        const matClone = this.getCellMatClone();
        if (!matClone) {
            print("Material clone is null. Check that cellMaterial is assigned.");
            return;
        }
    
        newImage.mainPass.material = matClone;
    
        // 6. Apply the texture
        if (newImage.mainPass) {
            newImage.mainPass.baseTex = this.whiteCell;
        } else {
            print("newImage.mainPass is null — check if material has valid shader with baseTex input.");
        }
    
        // 7. Set transform position and scale
        newImage.getSceneObject().getTransform().setLocalPosition(localPos);
        newImage.getSceneObject().getTransform().setLocalScale(new vec3(1, 1, 1));
    }

    
    
    //main helper function for coloring the cells of the mini map
    renderMiniMapCell(gridX: number, gridY: number, cellState: CellState | null): void {
        //get color of cell to draw via cellstate
        const color = this.getCellColor(cellState);
        //color correct cell given pos and color
        const img = this.miniMapCells[gridY * 5 + gridX] as any;
        if (img && img.mainPass) {
            // If this image doesn't already have its own material, clone it
            if (!img.__hasUniqueMaterial) {
                const clonedMat = img.mainMaterial.clone();
                img.mainMaterial = clonedMat;
                img.__hasUniqueMaterial = true;
            }
            //above if makes sure grid cells don't share colors accidentally
            img.mainPass.baseColor = color; // assuming `color` is already a vec4
        } else {
            print(`MiniMap cell "${img}" does not exist.`);
        }
        //this[imgName].mainPass.baseColor = new vec4(255, 0, 0, 1.0);
    }
    
    //helper function to get color of cell based on cellstate (null/OOB is gray, staked is transparent green, and claimed is green)
    getCellColor(cellState: CellState | null): vec4 {
        if (cellState == null) return new vec4(255, 0, 0, 0.5); // boundary / out of bounds
        switch (cellState) {
            case CellState.UNCLAIMED: return new vec4(0, 0, 255, 0.5); // blue
            case CellState.STAKED:   return new vec4(255, 255, 0, 0.5);  // yellow
            case CellState.CLAIMED:   return new vec4(0, 255, 0, 0.5); // green
            default: return new vec4(255, 0, 0, 0.5); // fallback red
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
    
        
        // Display the clamped coordinates and grid position
        this.uiText.text = 
            `Grid: (${clampedLat}, ${clampedLong})\n` + 
            `WorldPos: (${clampedgridx}, ${clampedgridy})\n` + 
            `N/A: (${clampedlatOff}, ${clampedlongOff})`;
    }
}
