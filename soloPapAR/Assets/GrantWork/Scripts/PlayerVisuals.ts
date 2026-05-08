import { SparseGrid } from './GridClaimer';
import { CellState } from './GridClaimer';
import { LocationTracker } from './LocationTracker';
import {Instantiator} from 'SpectaclesSyncKit.lspkg/Components/Instantiator';

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
        if (!this.networkedInstantiator.isReady()){
            print('instantiator not ready:(');
            return;
        }
        const newPosition = new vec3(x, y - (scale / 6), z);
        const cellScale = new vec3(scale, scale, scale);
        this.networkedInstantiator.instantiate(this.getClaimVolumeFromPlayerID(ID), {
            localPosition: newPosition,
            localScale: cellScale,
            onSuccess: (networkRoot) => {
                this.spawnedClaims.push(networkRoot.sceneObject);
            }
        });
    }


    //creates cube visuals for staked cell via instantiator.instantiate
    createWorldStakeVolume(ID: number, x: number, y: number, z: number, scale: number){
        if (!this.networkedInstantiator.isReady()){
            print('instantiator not ready:(');
            return;
        }
        const newPosition = new vec3(x, y - (scale / 6), z);
        this.networkedInstantiator.instantiate(this.getStakeVolumeFromPlayerID(ID), {
            localPosition: newPosition,
            localScale: new vec3(scale, scale, scale),
            onSuccess: (networkRoot) => {
                this.spawnedStakes.push(networkRoot.sceneObject);
            }
        });
        this.networkedInstantiator.instantiate(this.getStakePillarFromPlayerID(ID), {
            localPosition: newPosition,
            localScale: new vec3(1, scale, 1),
            onSuccess: (networkRoot) => {
                this.spawnedStakes.push(networkRoot.sceneObject);
            }
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
        this.diagnoseMiniMapLayout();
    }

    private diagnoseMiniMapLayout(): void {
        if (this.miniMapCells.length < 25) {
            print(`miniMapCells only has ${this.miniMapCells.length} entries, expected 25`);
            return;
        }
        const indices = [0, 1, 4, 5, 12, 20, 24];
        for (const i of indices) {
            const img = this.miniMapCells[i];
            if (!img) { print(`tile[${i}] is null`); continue; }
            const st = img.getSceneObject().getComponent("Component.ScreenTransform") as ScreenTransform;
            if (!st) { print(`tile[${i}] has no ScreenTransform`); continue; }
            print(`tile[${i}] anchors L=${st.anchors.left.toFixed(4)} R=${st.anchors.right.toFixed(4)} T=${st.anchors.top.toFixed(4)} B=${st.anchors.bottom.toFixed(4)}`);
            print(`tile[${i}] offsets L=${st.offsets.left.toFixed(2)} R=${st.offsets.right.toFixed(2)} T=${st.offsets.top.toFixed(2)} B=${st.offsets.bottom.toFixed(2)}`);
        }
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

    
    //renders the 5x5 minimap from networked cloud data; called every 0.3s tick by LocationTracker
    updateMiniMapNetworked(cells: (vec2 | null)[], getPlayerVisualID: (id: number) => number): void {
        for (let i = 0; i < 25; i++) {
            const miniMapX = i % 5;
            const miniMapY = Math.floor(i / 5);
            const color = this.getCellColorFromData(cells[i], getPlayerVisualID);
            const img = this.miniMapCells[miniMapY * 5 + miniMapX] as any;
            if (img && img.mainPass) {
                if (!img.__hasUniqueMaterial) {
                    img.mainMaterial = img.mainMaterial.clone();
                    img.__hasUniqueMaterial = true;
                }
                img.mainPass.baseColor = color;
            }
        }
    }

    private getCellColorFromData(cellData: vec2 | null, getPlayerVisualID: (id: number) => number): vec4 {
        if (cellData === null) return new vec4(0.75, 0.75, 0.75, 1); // out of bounds = light gray
        const stakedBy = cellData.y;
        const claimedBy = cellData.x;
        if (stakedBy !== 0) return this.getPlayerStakeColor(getPlayerVisualID(stakedBy));
        if (claimedBy !== 0) return this.getPlayerClaimColor(getPlayerVisualID(claimedBy));
        return new vec4(1, 1, 1, 0.2); // unclaimed = white, 80% transparent
    }

    private getPlayerClaimColor(visualID: number): vec4 {
        switch (visualID) {
            case 1: return new vec4(0, 1, 0, 0.425);           // green (P1ClaimTransparentMat)
            case 2: return new vec4(0, 0.333, 1, 0.425);       // blue (P2ClaimTransparentMat)
            case 3: return new vec4(0.666, 0, 0, 0.425);       // dark red (P3ClaimTransparentMat)
            case 4: return new vec4(0.666, 0, 1, 0.425);       // purple (P4ClaimTransparentMat)
            case 5: return new vec4(0.333, 0.266, 0, 0.425);   // olive (P5ClaimTransparentMat)
            default: return new vec4(0.5, 0.5, 0.5, 0.425);
        }
    }

    private getPlayerStakeColor(visualID: number): vec4 {
        switch (visualID) {
            case 1: return new vec4(1, 1, 0.498, 0.425);       // yellow (P1StakeTransparentMat)
            case 2: return new vec4(1, 0.666, 0, 0.425);       // orange (P2StakeTransparentMat)
            case 3: return new vec4(1, 1, 1, 0.425);           // white (P3StakeTransparentMat — update mat to make visible)
            case 4: return new vec4(1, 1, 1, 0.425);           // white (P4StakeTransparentMat — update mat to make visible)
            case 5: return new vec4(0.666, 0.666, 0, 0.425);   // olive (P5StakeTransparentMat)
            default: return new vec4(0.5, 0.5, 0.5, 0.425);
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
