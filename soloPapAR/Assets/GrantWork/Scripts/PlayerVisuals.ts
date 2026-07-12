import { SparseGrid } from './GridClaimer';
import { CellState } from './GridClaimer';
import { LocationTracker } from './LocationTracker';
import {Instantiator} from 'SpectaclesSyncKit.lspkg/Components/Instantiator';

@component
export class PlayerVisuals extends BaseScriptComponent {
    
    @input
    uiText: Text; // Reference to the Text UI component

    @input
    respawnCountdownText: Text; // dedicated centered screen-space countdown ("Respawning 3")

    @input
    showHUDText: boolean = true; // Toggle to show/hide the location HUD text

    @input
    showLogs: boolean = false; // gate debug prints via this.log()

    @input
    screenTransform: ScreenTransform; //reference to screen to render minimap on
    
    // sentinel: no in-bounds cell is negative, so the first ready tick always registers as a
    // new cell (guarantees the home claim fires even if the spawn cell is (0,0))
    prevGridPos: vec2 = new vec2(-1, -1); //previous grid (only update minimap if new != previous)
    
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
            this.log('instantiator not ready:(');
            return;
        }
        const newPosition = new vec3(x, y - (scale / 6), z);
        const cellScale = new vec3(scale, scale, scale);
        this.networkedInstantiator.instantiate(this.getClaimVolumeFromPlayerID(ID), {
            localPosition: newPosition,
            localScale: cellScale,
            onSuccess: (networkRoot) => {
                this.spawnedClaims.push(networkRoot.sceneObject);
                this.pruneOnDestroy(networkRoot);
            }
        });
    }


    //creates cube visuals for staked cell via instantiator.instantiate
    createWorldStakeVolume(ID: number, x: number, y: number, z: number, scale: number){
        if (!this.networkedInstantiator.isReady()){
            this.log('instantiator not ready:(');
            return;
        }
        const newPosition = new vec3(x, y - (scale / 6), z);
        this.networkedInstantiator.instantiate(this.getStakeVolumeFromPlayerID(ID), {
            localPosition: newPosition,
            localScale: new vec3(scale, scale, scale),
            onSuccess: (networkRoot) => {
                this.spawnedStakes.push(networkRoot.sceneObject);
                this.pruneOnDestroy(networkRoot);
            }
        });
        this.networkedInstantiator.instantiate(this.getStakePillarFromPlayerID(ID), {
            localPosition: newPosition,
            localScale: new vec3(1, scale, 1),
            onSuccess: (networkRoot) => {
                this.spawnedStakes.push(networkRoot.sceneObject);
                this.pruneOnDestroy(networkRoot);
            }
        });
    }
    
    // ── SDK-internals adapter (TD-3) ────────────────────────────────────────────────────────
    // The Instantiator exposes no public way to enumerate spawned objects and fires no callback
    // for REMOTE spawns, so destroying another player's visuals requires reaching its private
    // `spawnedInstances`. These three helpers are the ONLY place that `as any` cast lives, and
    // they tolerate both representations of the map:
    //   • current SDK: declared `Map<string, NetworkRootInfo>` but entries are stored as plain
    //     OBJECT properties (`map[id] = root`), never `.set()`; enumerate with `for..in`.
    //   • hypothetical future SDK: a real Map used via `.set()/.forEach()/.delete()`.
    // NOTE: do NOT branch on `instanceof Map` — the current map IS a Map instance yet holds its
    // entries as own properties, so `.forEach()` would visit zero of them. Hence "for..in first,
    // fall back to forEach only if for..in found nothing".

    // Single audited access point. Returns null (with a loud log) if the SDK removed/renamed it.
    private getSpawnedInstances(): any {
        const inst = (this.networkedInstantiator as any).spawnedInstances;
        if (!inst) {
            this.log("PlayerVisuals: WARNING - Instantiator.spawnedInstances is missing (SDK changed?) — remote-player visual cleanup is disabled");
            return null;
        }
        return inst;
    }

    // Iterate (networkId, networkRoot) pairs across either representation. Safe to delete the
    // current key from within `cb` (true for both for..in and Map.forEach).
    private forEachSpawnedInstance(cb: (networkId: string, networkRoot: any) => void): void {
        const inst = this.getSpawnedInstances();
        if (!inst) return;
        let sawAny = false;
        for (const networkId in inst) {
            sawAny = true;
            cb(networkId, inst[networkId]);
        }
        if (!sawAny && typeof inst.forEach === "function") {
            inst.forEach((networkRoot: any, networkId: string) => cb(networkId, networkRoot));
        }
    }

    // Delete an entry from either representation.
    private deleteSpawnedInstance(networkId: string): void {
        const inst = this.getSpawnedInstances();
        if (!inst) return;
        if (Object.prototype.hasOwnProperty.call(inst, networkId)) {
            delete inst[networkId];
        } else if (typeof inst.delete === "function") {
            inst.delete(networkId);
        }
    }
    // ────────────────────────────────────────────────────────────────────────────────────────

    // Keep the Instantiator's spawnedInstances map from accumulating destroyed holders:
    // when this locally-spawned object is destroyed (locally OR remotely), drop its entry.
    // onDestroyed (NetworkRootInfo) fires for both destruction paths, so this also covers
    // the self-death path (DestroyAllClaims/Stakes), where spawnedInstances is never pruned.
    private pruneOnDestroy(networkRoot: any): void {
        if (!networkRoot || !networkRoot.onDestroyed) return;
        networkRoot.onDestroyed.add(() => {
            this.deleteSpawnedInstance(networkRoot.networkId);
        });
    }

    // Destroy all visual objects (claims + stakes + pillars) spawned by a specific player.
    // Works on every device: iterates the Instantiator's internal spawnedInstances map,
    // which holds all objects created during the session (both local and remote spawns).
    // Prefab names are in the form "P{visualID}ClaimCube", "P{visualID}StakeCube", etc.,
    // so matching the "P{N}" prefix is sufficient to find all objects for that player.
    // The SDK never prunes spawnedInstances, so we prune matched (and stale) entries here to
    // stop re-scanning destroyed holders and reading from their deleted realtime stores.
    destroyPlayerVisuals(clientID: number, getPlayerVisualID: (id: number) => number): void {
        const visualID = getPlayerVisualID(clientID);
        const prefix = "P" + visualID;
        const toDestroy: { id: string; obj: SceneObject }[] = [];
        this.forEachSpawnedInstance((networkId, networkRoot) => {
            // Drop obviously-stale entries (already-destroyed holder / missing store) as we go.
            if (!networkRoot || !networkRoot.dataStore || !networkRoot.sceneObject) {
                this.deleteSpawnedInstance(networkId);
                return;
            }
            let prefabName = "";
            try {
                prefabName = networkRoot.dataStore.getString("_prefab_name");
            } catch (e) {
                // Reading a deleted realtime store — the entry is stale; prune and skip.
                this.deleteSpawnedInstance(networkId);
                return;
            }
            if (prefabName && prefabName.startsWith(prefix)) {
                toDestroy.push({ id: networkId, obj: networkRoot.sceneObject });
            }
        });
        for (const entry of toDestroy) {
            if (entry.obj) entry.obj.destroy();
            this.deleteSpawnedInstance(entry.id); // prune so this entry is never re-scanned on a later death
        }
        this.log("PlayerVisuals: Destroyed " + toDestroy.length + " objects for player " + clientID + " (P" + visualID + ")");
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
        this.log('removed all home claims');
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
        this.log('removed all stakes');
    }
   
    onAwake(){
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
        this.alignMiniMapCells();
        this.hideRespawnCountdown();
    }

    // seconds = whole seconds remaining; blocked = timer frozen (on territory OR out of bounds);
    // outOfBounds = frozen specifically because the player is outside the arena.
    showRespawnCountdown(seconds: number, blocked: boolean, outOfBounds: boolean = false): void {
        if (!this.respawnCountdownText) return;
        this.respawnCountdownText.getSceneObject().enabled = true;
        if (blocked) {
            this.respawnCountdownText.text = outOfBounds
                ? "You died!\nReturn to the play area"
                : "You died!\nMove to open ground";
        } else {
            this.respawnCountdownText.text = "You died!\nRespawning in " + seconds;
        }
    }

    hideRespawnCountdown(): void {
        if (!this.respawnCountdownText) return;
        this.respawnCountdownText.text = "";
        this.respawnCountdownText.getSceneObject().enabled = false;
    }

    private alignMiniMapCells(): void {
        if (this.miniMapCells.length < 25) {
            this.log(`miniMapCells only has ${this.miniMapCells.length} entries, expected 25`);
            return;
        }

        const getST = (idx: number): ScreenTransform | null => {
            const img = this.miniMapCells[idx];
            if (!img) return null;
            return img.getSceneObject().getComponent("Component.ScreenTransform") as ScreenTransform || null;
        };

        // Parent ST is needed to convert world coords back to anchor space
        const firstImg = this.miniMapCells[0];
        if (!firstImg) return;
        const parentObj = firstImg.getSceneObject().getParent();
        if (!parentObj) return;
        const parentST = parentObj.getComponent("Component.ScreenTransform") as ScreenTransform;
        if (!parentST) return;

        // Read center cell (player position, idx 12) in world space to determine actual pixel size
        const stCenter = getST(12);
        if (!stCenter) return;
        const wCenter   = stCenter.localPointToWorldPoint(new vec2(0, 0));
        const wTopRight = stCenter.localPointToWorldPoint(new vec2(1, 1));
        const cellPixW  = Math.abs(wTopRight.x - wCenter.x) * 2;
        const cellPixH  = Math.abs(wTopRight.y - wCenter.y) * 2;

        // Force square cells using the smaller pixel dimension
        const cellPix = Math.min(cellPixW, cellPixH);

        // Grid origin (top-left) in world space, centered on the player cell
        const gridLeft = wCenter.x - 2.5 * cellPix;
        const gridTop  = wCenter.y + 2.5 * cellPix;

        for (let row = 0; row < 5; row++) {
            for (let col = 0; col < 5; col++) {
                const idx = row * 5 + col;
                const st = getST(idx);
                if (!st) { this.log(`tile[${idx}] is null or missing ScreenTransform`); continue; }

                // Cell corners in world space
                const wL = gridLeft + col * cellPix;
                const wR = gridLeft + (col + 1) * cellPix;
                const wT = gridTop  - row * cellPix;
                const wB = gridTop  - (row + 1) * cellPix;

                // Convert world corners to parent's local normalized anchor space
                const tl = parentST.worldPointToLocalPoint(new vec3(wL, wT, 0));
                const br = parentST.worldPointToLocalPoint(new vec3(wR, wB, 0));

                st.anchors.left   = tl.x;
                st.anchors.right  = br.x;
                st.anchors.top    = tl.y;
                st.anchors.bottom = br.y;
                st.offsets.left   = 0;
                st.offsets.right  = 0;
                st.offsets.top    = 0;
                st.offsets.bottom = 0;
            }
        }
    }
    
    onUpdate() {
        // get radians rotation in z
        const yawRadians = this.deviceTracker.getDeviceTrackerRotation();
        //update arrow only if the heading actually changed (memoized in previousRotation)
        if (this.previousRotation != yawRadians){
            // update the player arrow with appropriate rotation
            this.rotatePlayerArrow(yawRadians);
            this.previousRotation = yawRadians; // remember this heading so a still head skips the rebuild
        }

    }
    
    //main function to adjust player direction facing arrow given rotation
    rotatePlayerArrow(yawRads: number){
        // Access the transform component of the playerArrow img
        let arrowTransform = this.playerArrow.getTransform();
        let rotationQuat = quat.fromEulerAngles(0, 0, yawRads);

        // Set the rotation of the transform component
        arrowTransform.setLocalRotation(rotationQuat);
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
                    //this.log('x: ' + gridX + ', y: ' + gridY + ', state: ' + cellState);
                    this.renderMiniMapCell(miniMapX, miniMapY, cellState);
                } else {
                    //renders null cell state
                    this.renderMiniMapCell(miniMapX, miniMapY, null); // Out of bounds = boundary
                    //this.log('x: ' + gridX + ', y: ' + gridY + ', is out of bounds?');
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
            this.log("Failed to create CellObject scene object.");
            return;
        }
    
        // 2. Parent it to the screen transform’s scene object
        const parentObj = this.screenTransform.getSceneObject();
        if (!parentObj) {
            this.log("screenTransform's SceneObject is null.");
            return;
        }
        cellObj.setParent(parentObj);
    
        // 3. Add a ScreenTransform for UI positioning
        const transform = cellObj.createComponent("Component.ScreenTransform");
        if (!transform) {
            this.log("Failed to create ScreenTransform on CellObject.");
            return;
        }
    
        // 4. Add the Image component
        const newImage = cellObj.createComponent("Component.Image");
        if (!newImage) {
            this.log("Failed to create Image component on CellObject.");
            return;
        }
    
        // 5. Clone the material and assign
        const matClone = this.getCellMatClone();
        if (!matClone) {
            this.log("Material clone is null. Check that cellMaterial is assigned.");
            return;
        }
    
        newImage.mainPass.material = matClone;
    
        // 6. Apply the texture
        if (newImage.mainPass) {
            newImage.mainPass.baseTex = this.whiteCell;
        } else {
            this.log("newImage.mainPass is null — check if material has valid shader with baseTex input.");
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
            this.log(`MiniMap cell "${img}" does not exist.`);
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

    
    //renders the 5x5 minimap from networked cloud data; called every 0.1s tick by LocationTracker
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
                // Skip the material write when this cell's color is unchanged (e.g. only one windowed
                // cell changed but we redraw all 25). Compare component-wise; colors are fresh vec4s.
                const last = img.__lastColor;
                if (!last || last.x !== color.x || last.y !== color.y || last.z !== color.z || last.w !== color.w) {
                    img.mainPass.baseColor = color;
                    img.__lastColor = color;
                }
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
            case 3: return new vec4(0.667, 0, 0, 0.425);       // dark red (P3ClaimTransparentMat)
            case 4: return new vec4(0.667, 0, 1, 0.425);       // purple (P4ClaimTransparentMat)
            case 5: return new vec4(0.333, 0.266, 0, 0.425);   // olive (P5ClaimTransparentMat)
            default: return new vec4(0.5, 0.5, 0.5, 0.425);
        }
    }

    private getPlayerStakeColor(visualID: number): vec4 {
        switch (visualID) {
            case 1: return new vec4(1, 1, 0.498, 0.425);       // yellow (P1StakeTransparentMat)
            case 2: return new vec4(1, 0.666, 0, 0.425);       // orange (P2StakeTransparentMat)
            case 3: return new vec4(1, 0.333, 1, 0.425);        // magenta (P3StakeTransparentMat)
            case 4: return new vec4(0.667, 0.667, 1, 0.425);   // lavender (P4StakeTransparentMat)
            case 5: return new vec4(0.666, 0.666, 0, 0.425);   // olive (P5StakeTransparentMat)
            default: return new vec4(0.5, 0.5, 0.5, 0.425);
        }
    }

    //function to display info as text on screen
    //this is called by grid claimer in update pos
    updateHUDText(lat: number, long: number, gridx: number, gridy: number, latOff: number, longOff: number): void {
        if (!this.showHUDText) {
            this.uiText.text = "";
            return;
        }

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

    //gated logging: only prints when showLogs is enabled
    private log(msg: string): void {
        if (this.showLogs) {
            print(msg);
        }
    }
}
