import { SparseGrid } from './GridClaimer';
import { CellState } from './GridClaimer';
import { LocationTracker } from './LocationTracker';
import {Instantiator} from 'SpectaclesSyncKit.lspkg/Components/Instantiator';

// F3/NET-14: every spawned volume's realtime store is stamped with its owner's clientID under
// this key, so death sweeps can match objects by owner instead of by the "P{visualID}" prefab
// prefix (which depends on a color slot every client is simultaneously zeroing during a death).
const OWNER_KEY = "_papar_owner";

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
   
    // Global array to hold all instances of claims spawned by THIS device. Entries may be
    // destroyed natives (a remote deleteRealtimeStore destroys the object without splicing this
    // array) — consume them only via safeDestroy (NET-13).
    spawnedClaims: SceneObject[] = [];

    // Global array to hold all instances of stakes spawned by THIS device. Same destroyed-native
    // caveat as spawnedClaims — consume only via safeDestroy (NET-13).
    spawnedStakes: SceneObject[] = [];
    
    private previousRotation: number = 0;

    private previousArrowOffset: vec2 | null = null; // exact-compare memo, like previousRotation

    private arrowScale = 0.6; // render the arrow at 60% of its authored size

    // Geometry captured once by alignMiniMapCells — everything pre-converted into the arrow
    // parent's normalized ANCHOR space, so the per-frame update is pure arithmetic with no
    // world-space conversions. The world<->screen mapping can change after onAwake (render
    // target / ortho camera initialization), so converting capture-time world coords per
    // frame drifts the arrow off the map; capture-time anchors share the cells' guarantee.
    // null = minimap misaligned/unassigned -> arrow slide disabled
    private arrowGeom: {
        centerX: number;  // map center-cell center (anchor space)
        centerY: number;
        cellW: number;    // one minimap cell (anchor units, X)
        cellH: number;    // one minimap cell (anchor units, Y)
        halfW: number;    // arrow's authored half-size (anchor units)
        halfH: number;
    } | null = null;

    // Per-cell stake "dot" overlay: a small centered Image aligned to its minimap cell the SAME
    // way the claim cells are (same parent, same world→anchor conversion, same render layer),
    // shown only when that cell is staked. Index-aligned to miniMapCells; created + positioned
    // lazily in positionStakeDot (driven by alignMiniMapCells). Lets a cell show BOTH its
    // background (claim color / white) AND its stake (the dot) at once.
    private stakeDots: (Image | null)[] = [];

    // The stake dot spans this fraction of the cell (centered). Tunable; ~0.4 = small dot.
    private readonly stakeDotScale = 0.4;


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
    
    // F3: builds the customDataStore for one instantiate call, stamping the spawn's owner. A
    // FRESH store per call — the stake cube + pillar are two instantiate calls; sharing one
    // store would cross-contaminate the SDK's per-object keys (_network_id/_prefab_name/_init_*),
    // which the Instantiator writes on top of the custom data.
    private makeOwnerStore(ownerClientID: number): GeneralDataStore {
        const store = GeneralDataStore.create();
        store.putInt(OWNER_KEY, ownerClientID);
        return store;
    }

    //creates a cell cube visual for claimed cell via instantiator.instantiate
    // ownerClientID (F3): stamped into the spawn's realtime store so death sweeps match by owner.
    // isStillValid (F1/NET-11): instantiate() completes only after a createRealtimeStore network
    // round-trip, so a spawn requested by a life/batch that has since ended can materialize AFTER
    // cleanup already ran — orphaning it on every client. onSuccess re-checks the closure and
    // destroys the object at the source instead of tracking it (the store deletion then
    // propagates the cleanup to every client).
    createWorldClaimVolume(ID: number, x: number, y: number, z: number, scale: number, ownerClientID: number = 0, isStillValid?: () => boolean){
        if (!this.networkedInstantiator.isReady()){
            this.log('instantiator not ready:(');
            return;
        }
        const newPosition = new vec3(x, y - (scale / 6), z);
        const cellScale = new vec3(scale, scale, scale);
        this.networkedInstantiator.instantiate(this.getClaimVolumeFromPlayerID(ID), {
            localPosition: newPosition,
            localScale: cellScale,
            customDataStore: this.makeOwnerStore(ownerClientID),
            onSuccess: (networkRoot) => {
                // prune FIRST so even a spawn we immediately destroy drops its map entry
                this.pruneOnDestroy(networkRoot);
                if (isStillValid && !isStillValid()) {
                    this.safeDestroy(networkRoot.sceneObject);
                    return;
                }
                this.spawnedClaims.push(networkRoot.sceneObject);
            },
            // The SDK failure path calls onError unguarded — always pass one.
            onError: (message) => this.log("createWorldClaimVolume failed: " + message)
        });
    }


    //creates cube visuals for staked cell via instantiator.instantiate
    // ownerClientID / isStillValid: see createWorldClaimVolume — same F3 owner stamp (a fresh
    // store per instantiate call) and same F1 in-flight-spawn gating in each onSuccess.
    createWorldStakeVolume(ID: number, x: number, y: number, z: number, scale: number, ownerClientID: number = 0, isStillValid?: () => boolean){
        if (!this.networkedInstantiator.isReady()){
            this.log('instantiator not ready:(');
            return;
        }
        const newPosition = new vec3(x, y - (scale / 6), z);
        this.networkedInstantiator.instantiate(this.getStakeVolumeFromPlayerID(ID), {
            localPosition: newPosition,
            localScale: new vec3(scale, scale, scale),
            customDataStore: this.makeOwnerStore(ownerClientID),
            onSuccess: (networkRoot) => {
                this.pruneOnDestroy(networkRoot);
                if (isStillValid && !isStillValid()) {
                    this.safeDestroy(networkRoot.sceneObject);
                    return;
                }
                this.spawnedStakes.push(networkRoot.sceneObject);
            },
            onError: (message) => this.log("createWorldStakeVolume (cube) failed: " + message)
        });
        this.networkedInstantiator.instantiate(this.getStakePillarFromPlayerID(ID), {
            localPosition: newPosition,
            localScale: new vec3(1, scale, 1),
            customDataStore: this.makeOwnerStore(ownerClientID),
            onSuccess: (networkRoot) => {
                this.pruneOnDestroy(networkRoot);
                if (isStillValid && !isStillValid()) {
                    this.safeDestroy(networkRoot.sceneObject);
                    return;
                }
                this.spawnedStakes.push(networkRoot.sceneObject);
            },
            onError: (message) => this.log("createWorldStakeVolume (pillar) failed: " + message)
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
    // Matching is primarily by the "_papar_owner" clientID stamped into each spawn's store
    // (F3/NET-14) — independent of the color slots, which every client is simultaneously
    // zeroing during a death. The "P{visualID}" prefab-name prefix is only a FALLBACK for
    // objects with no owner stamp, resolved from visualIDHint (the victim's color index
    // carried in the death payload) when valid, else the getPlayerVisualID resolver.
    // ownerKeyOnly disables the prefix fallback entirely — used by the leave re-sweeps, where
    // a prefix match could hit a rejoined player's NEW visuals.
    // The SDK never prunes spawnedInstances, so we prune matched (and stale) entries here to
    // stop re-scanning destroyed holders and reading from their deleted realtime stores.
    destroyPlayerVisuals(clientID: number, getPlayerVisualID: (id: number) => number, visualIDHint?: number, ownerKeyOnly: boolean = false): void {
        const visualID = (Number.isFinite(visualIDHint) && visualIDHint >= 1 && visualIDHint <= 5)
            ? visualIDHint
            : getPlayerVisualID(clientID);
        const prefix = "P" + visualID;
        const toDestroy: { id: string; obj: SceneObject }[] = [];
        this.forEachSpawnedInstance((networkId, networkRoot) => {
            // Drop obviously-stale entries (already-destroyed holder / missing store) as we go.
            if (!networkRoot || !networkRoot.dataStore || !networkRoot.sceneObject) {
                this.deleteSpawnedInstance(networkId);
                return;
            }
            // Read owner + prefab name inside ONE try/catch: a throw means the realtime store
            // was deleted — the entry is stale; prune and skip. Never route a throw to the
            // prefix fallback (a half-read entry must not be matched by guesswork).
            let owner = 0;
            let prefabName = "";
            try {
                const store = networkRoot.dataStore;
                if (store.has(OWNER_KEY)) {
                    owner = store.getInt(OWNER_KEY);
                }
                prefabName = store.getString("_prefab_name");
            } catch (e) {
                this.deleteSpawnedInstance(networkId);
                return;
            }
            let matches = false;
            if (owner !== 0) {
                matches = owner === clientID; // stamped: the owner key is authoritative
            } else if (!ownerKeyOnly) {
                matches = !!prefabName && prefabName.startsWith(prefix);
            }
            if (matches) {
                toDestroy.push({ id: networkId, obj: networkRoot.sceneObject });
            }
        });
        for (const entry of toDestroy) {
            this.safeDestroy(entry.obj);
            this.deleteSpawnedInstance(entry.id); // prune so this entry is never re-scanned on a later death
        }
        this.log("PlayerVisuals: Destroyed " + toDestroy.length + " objects for player " + clientID + " (P" + visualID + (ownerKeyOnly ? ", owner-key only" : "") + ")");
    }

    // NET-13: destroy that can never throw or abort a teardown loop. A remote deleteRealtimeStore
    // can destroy the native object under us without splicing our arrays, and calling destroy()
    // on a destroyed native throws — `obj && obj.destroy` does not detect that (needs isNull).
    // The catch must never be empty: silent catches would make NET-13-class races undiagnosable
    // on device.
    private safeDestroy(obj: SceneObject): void {
        if (!obj || isNull(obj)) return;
        try {
            obj.destroy();
        } catch (e) {
            this.log("safeDestroy: " + e);
        }
    }

    //destroy all visible color volumes representing home claims
    //entries may be destroyed natives — consume only via safeDestroy; the length reset lives in
    //a finally so one bad entry can't leave dead refs poisoning every later teardown (NET-13)
    DestroyAllClaims(){
        try {
            for (let obj of this.spawnedClaims) {
                this.safeDestroy(obj);
            }
        } finally {
            //set length to 0 to be reused
            this.spawnedClaims.length = 0;
        }
        this.log('removed all home claims');
    }

    //destroy all visible color volumes representing staked cells
    //same safeDestroy + finally hardening as DestroyAllClaims (NET-13)
    DestroyAllStakes(){
        try {
            for (let obj of this.spawnedStakes) {
                this.safeDestroy(obj);
            }
        } finally {
            //set length to 0 to be reused
            this.spawnedStakes.length = 0;
        }
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

        if (this.stakeDots.length !== 25) this.stakeDots = new Array(25).fill(null);

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

                // Stake dot overlay for this cell: a smaller centered square, positioned in the
                // SAME parent + world→anchor space as the cell above, so it aligns exactly like the
                // claim (just inset by stakeDotScale). wT > wB (top has the larger world Y).
                const s = this.stakeDotScale;
                const cxw = (wL + wR) / 2;
                const cyw = (wT + wB) / 2;
                const halfW = ((wR - wL) / 2) * s;
                const halfH = ((wT - wB) / 2) * s;
                const dtl = parentST.worldPointToLocalPoint(new vec3(cxw - halfW, cyw + halfH, 0));
                const dbr = parentST.worldPointToLocalPoint(new vec3(cxw + halfW, cyw - halfH, 0));
                this.positionStakeDot(idx, parentObj, this.miniMapCells[idx].getSceneObject(), dtl, dbr);
            }
        }

        this.captureArrowGeometry(wCenter, cellPix);
    }

    // Creates (once, lazily) and positions cell idx's stake-dot overlay Image. The dot is a child
    // of the cells' SHARED parent (Full Frame Region) — the same parent the claim cells live under —
    // and its anchor rect is supplied by alignMiniMapCells using the identical world→anchor
    // conversion used for the cells, so the dot lines up exactly inside its cell. It copies the
    // cell's render layer so the same UI camera draws it, gets its own cloned flat material
    // (independent color) + the white cell texture, and starts disabled (applyStakeDot toggles/
    // colors it per state). Created after the cells in hierarchy order, so it renders on top.
    private positionStakeDot(idx: number, parentObj: SceneObject, cellObj: SceneObject, tl: vec2, br: vec2): void {
        if (!this.stakeDots[idx]) {
            if (!this.cellMaterial || !this.whiteCell) {
                this.log("positionStakeDot: cellMaterial/whiteCell unassigned — stake dot " + idx + " skipped");
                return;
            }
            const dotObj = global.scene.createSceneObject("StakeDot" + idx);
            dotObj.setParent(parentObj);
            dotObj.layer = cellObj.layer; // draw on the same UI camera/layer as the cells
            dotObj.createComponent("Component.ScreenTransform");
            const dotImg = dotObj.createComponent("Component.Image") as Image;
            dotImg.mainMaterial = this.cellMaterial.clone();
            dotImg.mainPass.baseTex = this.whiteCell;
            dotObj.enabled = false; // shown only when the cell is staked
            this.stakeDots[idx] = dotImg;
        }
        const dot = this.stakeDots[idx];
        if (!dot) return;
        const st = dot.getSceneObject().getComponent("Component.ScreenTransform") as ScreenTransform;
        if (!st) return;
        st.anchors.left   = tl.x;
        st.anchors.right  = br.x;
        st.anchors.top    = tl.y;
        st.anchors.bottom = br.y;
        st.offsets.left = 0; st.offsets.right = 0; st.offsets.top = 0; st.offsets.bottom = 0;
    }

    // Captures everything positionPlayerArrow needs, while the arrow still sits at its
    // scene-authored rect (the size read is position-independent). All values are converted
    // into the parent's anchor space HERE, at one consistent instant — the same space and
    // world mapping the cell anchors were just written with — so the arrow's per-frame math
    // stays valid even if the screen/camera mapping changes after onAwake.
    private captureArrowGeometry(wCenter: vec3, cellPix: number): void {
        if (!this.playerArrow) { this.log("playerArrow not assigned — arrow slide disabled"); return; }
        const parentObj = this.playerArrow.getSceneObject().getParent();
        const parentST = parentObj
            ? parentObj.getComponent("Component.ScreenTransform") as ScreenTransform : null;
        if (!parentST) { this.log("playerArrow parent has no ScreenTransform — arrow slide disabled"); return; }
        const centerL = parentST.worldPointToLocalPoint(new vec3(wCenter.x, wCenter.y, 0));
        const cellL   = parentST.worldPointToLocalPoint(new vec3(wCenter.x + cellPix, wCenter.y - cellPix, 0));
        const aCL  = parentST.worldPointToLocalPoint(this.playerArrow.localPointToWorldPoint(new vec2(0, 0)));
        const aTRL = parentST.worldPointToLocalPoint(this.playerArrow.localPointToWorldPoint(new vec2(1, 1)));
        this.arrowGeom = {
            centerX: centerL.x,
            centerY: centerL.y,
            cellW: Math.abs(cellL.x - centerL.x),
            cellH: Math.abs(cellL.y - centerL.y),
            halfW: Math.abs(aTRL.x - aCL.x) * this.arrowScale,
            halfH: Math.abs(aTRL.y - aCL.y) * this.arrowScale,
        };
        this.log("arrowGeom captured: center(" + centerL.x + ", " + centerL.y + ") cell("
            + this.arrowGeom.cellW + ", " + this.arrowGeom.cellH + ") half("
            + this.arrowGeom.halfW + ", " + this.arrowGeom.halfH + ")");
        // offsets are authored zero; assert once so the per-frame writes touch anchors only
        const st = this.playerArrow;
        st.offsets.left = 0; st.offsets.right = 0; st.offsets.top = 0; st.offsets.bottom = 0;
        this.positionPlayerArrow(new vec2(0, 0)); // snap onto the true map center immediately
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

        // slide the arrow within (and briefly past) the center minimap cell — sub-cell position
        if (this.arrowGeom) {
            const off = this.deviceTracker.getMiniMapArrowOffset();
            const prev = this.previousArrowOffset;
            if (!prev || prev.x !== off.x || prev.y !== off.y) {
                this.positionPlayerArrow(off);
                this.previousArrowOffset = off;
            }
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

    // Rebuilds the arrow's anchor rect centered at (map center + off cells), size-preserving.
    // Pure anchor-space arithmetic — no world conversions (see arrowGeom). Anchors-only: the
    // layout derives the Transform's POSITION from anchors while rotatePlayerArrow's
    // setLocalRotation stays untouched (layout never derives rotation), so slide and spin
    // compose without fighting.
    private positionPlayerArrow(off: vec2): void {
        const g = this.arrowGeom;
        if (!g) return;
        const cx = g.centerX + off.x * g.cellW;  // grid +X → screen right
        const cy = g.centerY - off.y * g.cellH;  // grid +Z (row+) → screen DOWN (+y is up in anchor space)
        const st = this.playerArrow;
        st.anchors.left   = cx - g.halfW;
        st.anchors.right  = cx + g.halfW;
        st.anchors.top    = cy + g.halfH;
        st.anchors.bottom = cy - g.halfH;
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
            const cell = cells[i];
            // Background square: claim color if claimed, white if unclaimed, gray if OOB. Stake is
            // NOT drawn here — it's the dot overlay — so a staked cell keeps its underlying claim
            // (or white) background visible in the space AROUND the dot.
            const bgColor = this.getCellBackgroundColor(cell, getPlayerVisualID);
            const img = this.miniMapCells[i] as any;
            if (img && img.mainPass) {
                if (!img.__hasUniqueMaterial) {
                    img.mainMaterial = img.mainMaterial.clone();
                    img.__hasUniqueMaterial = true;
                }
                // Skip the material write when this cell's color is unchanged (e.g. only one windowed
                // cell changed but we redraw all 25). Compare component-wise; colors are fresh vec4s.
                const last = img.__lastColor;
                if (!last || last.x !== bgColor.x || last.y !== bgColor.y || last.z !== bgColor.z || last.w !== bgColor.w) {
                    img.mainPass.baseColor = bgColor;
                    img.__lastColor = bgColor;
                }
            }

            // Stake dot overlay: shown in the staker's color when the cell is staked, else hidden.
            const stakedBy = cell !== null ? cell.y : 0; // cell.y = stakedBy
            this.applyStakeDot(
                i,
                stakedBy !== 0 ? this.getPlayerStakeColor(getPlayerVisualID(stakedBy)) : null
            );
        }
    }

    // Toggles/colors cell i's stake dot. color === null hides the dot (cell not staked); a color
    // enables it and tints it. Memoized on the dot's own __lastColor (like the background cells)
    // so a redraw only touches the material / enabled state on an actual change.
    private applyStakeDot(i: number, color: vec4 | null): void {
        const dot = this.stakeDots[i];
        if (!dot) return;
        const obj = dot.getSceneObject();
        const dotAny = dot as any;
        if (color === null) {
            if (obj.enabled) obj.enabled = false;
            return;
        }
        if (!obj.enabled) obj.enabled = true;
        const last = dotAny.__lastColor;
        if (!last || last.x !== color.x || last.y !== color.y || last.z !== color.z || last.w !== color.w) {
            dot.mainPass.baseColor = color;
            dotAny.__lastColor = color;
        }
    }

    // Background color for a cell's full square. Stake is drawn separately as the dot overlay, so
    // the background reflects only claim state: a claimed cell keeps its claim color (visible
    // around any stake dot on top), an unclaimed cell is white, and OOB is gray.
    private getCellBackgroundColor(cellData: vec2 | null, getPlayerVisualID: (id: number) => number): vec4 {
        if (cellData === null) return new vec4(0.75, 0.75, 0.75, 1); // out of bounds = light gray
        const claimedBy = cellData.x;
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
    //called every 0.1s tick by LocationTracker as (grid x, grid y, world x, world z, 0, 0).
    //These were named lat/long back when position came from GPS; position now comes solely
    //from DeviceTracking world space, so no geolocation data reaches this HUD.
    updateHUDText(gridX: number, gridY: number, worldX: number, worldZ: number, spareA: number, spareB: number): void {
        if (!this.showHUDText) {
            this.uiText.text = "";
            return;
        }

        // Clamp each value to 5 decimal places
        const clampedGridX = gridX.toFixed(5);
        const clampedGridY = gridY.toFixed(5);
        const clampedWorldX = worldX.toFixed(5);
        const clampedWorldZ = worldZ.toFixed(5);
        const clampedSpareA = spareA.toFixed(5);
        const clampedSpareB = spareB.toFixed(5);

        // Display the clamped grid and world position
        this.uiText.text =
            `Grid: (${clampedGridX}, ${clampedGridY})\n` +
            `WorldPos: (${clampedWorldX}, ${clampedWorldZ})\n` +
            `N/A: (${clampedSpareA}, ${clampedSpareB})`;
    }

    //gated logging: only prints when showLogs is enabled
    private log(msg: string): void {
        if (this.showLogs) {
            print(msg);
        }
    }
}
