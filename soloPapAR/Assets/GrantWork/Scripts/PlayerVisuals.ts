import { SparseGrid } from './GridClaimer';
import { CellState } from './GridClaimer';
import { LocationTracker } from './LocationTracker';
import { SessionController } from "SpectaclesSyncKit.lspkg/Core/SessionController";

// The cube objects currently shown at one cell (see setCellCubes).
type CellCubes = {
    claimID: number; claim: SceneObject | null;
    stakeID: number; stake: SceneObject | null; pillar: SceneObject | null;
};

@component
export class PlayerVisuals extends BaseScriptComponent {
    
    @input
    uiText: Text; // Reference to the Text UI component

    @input
    respawnCountdownText: Text; // dedicated centered screen-space countdown ("Respawning 3")

    // FEAT-2 leaderboard: 4 screen-space Text rows (top 3 + the local player's own row, shown
    // only when they're outside the top 3). Optional — the leaderboard no-ops if unassigned.
    @input
    @allowUndefined
    leaderboardRows: Text[];

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
    
    //array of cells going one column at a time
    @input
    miniMapCells: Image[]; // array of cells to be colored for minimap
   
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

    // FEAT-2 leaderboard: per-row player-color dot + white "you" ring, built at runtime by
    // layoutLeaderboard (index-aligned to leaderboardRows).
    private leaderboardDots: (Image | null)[] = [];
    private leaderboardRings: (Image | null)[] = [];
    // Layout is owned by code (layoutLeaderboard), in the parent's anchor space (screen = -1..1),
    // so it does not depend on how the row Text rects are authored in the editor.
    private readonly leaderboardTop = 0.92;        // top edge of row 0
    private readonly leaderboardLeft = -0.92;      // left edge of the outline square
    private readonly leaderboardRowPitch = 0.13;   // row height / spacing
    private readonly leaderboardDotScale = 0.48;   // color square side as a fraction of the row pitch
    private readonly leaderboardRingScale = 1.4;   // white outline square relative to the color square
    private readonly leaderboardOwnRowGap = 0.5;   // extra gap above row 3 (own score), in row pitches
    private readonly leaderboardTextWidth = 0.6;   // width of the score text rect
    private readonly LEADERBOARD_ROW_COUNT = 4;    // top three + the local player's own row
    private leaderboardXPerY = NaN;                // screen aspect ratio the rows were last positioned with


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
    
    // ── World cubes: local, drawn from the cell grid ────────────────────────────────────────
    // Cubes are NOT networked objects. Every client already has the synced cell grid, so each
    // client builds and destroys its own cubes from the cell values (Networker.noteCell calls
    // setCellCubes whenever a cell's claim or stake owner changes). A cube therefore can never
    // disagree with the grid, a death needs no cube cleanup of its own, and spawning or
    // removing a cube sends nothing over the network.
    // One record per cell that currently shows something. claimID / stakeID are the color
    // indices (1-5) the objects were built for; 0 = none.
    private cellCubes: Map<string, CellCubes> = new Map();
    private cubeParent: SceneObject | null = null;
    private warnedCubeSetup = false;

    // The shared colocated root (ColocatedWorld) — the same parent the networked cubes used,
    // so local positions mean the same thing on every device.
    private getCubeParent(): SceneObject | null {
        if (this.cubeParent && !isNull(this.cubeParent)) return this.cubeParent;
        try {
            const located = SessionController.getInstance().getLocatedAtComponent();
            this.cubeParent = located ? located.getSceneObject() : null;
        } catch (e) {
            this.cubeParent = null;
        }
        return this.cubeParent;
    }

    // Cubes sit at the local viewer's body height at the moment they are drawn.
    private cubeHeight(scale: number): number {
        let y = 0;
        try {
            y = this.deviceTracker.playerTracker.getTransform().getWorldPosition().y;
        } catch (e) {
            y = 0;
        }
        return y - (scale / 6);
    }

    // Same construction the SyncKit Instantiator used: a holder under the parent carrying the
    // position and scale, with the prefab instantiated beneath it.
    private spawnLocal(prefab: ObjectPrefab, x: number, y: number, z: number, localScale: vec3): SceneObject | null {
        const parent = this.getCubeParent();
        if (!prefab || !parent) {
            // A setup error, not a debug detail: say so once even with showLogs off.
            if (!this.warnedCubeSetup) {
                this.warnedCubeSetup = true;
                print("PlayerVisuals: CONFIG ERROR - cannot draw cubes (" + (prefab ? "colocated parent" : "cube prefab") + " missing)");
            }
            return null;
        }
        let holder: SceneObject | null = null;
        try {
            holder = global.scene.createSceneObject("cellCube");
            holder.setParent(parent);
            const t = holder.getTransform();
            t.setLocalPosition(new vec3(x, y, z));
            t.setLocalScale(localScale);
            prefab.instantiate(holder);
            return holder;
        } catch (e) {
            this.log("PlayerVisuals: cube spawn failed: " + e);
            this.safeDestroy(holder);
            return null;
        }
    }

    // Make the cubes at one cell match its state. claimVisualID / stakeVisualID are color
    // indices (0 = none). (x, z) is the cell center in the colocated space. Only what changed
    // is rebuilt, so calling this with unchanged values is free.
    setCellCubes(key: string, claimVisualID: number, stakeVisualID: number, x: number, z: number, scale: number): void {
        let rec = this.cellCubes.get(key);
        if (!rec) {
            if (!claimVisualID && !stakeVisualID) return;
            rec = { claimID: 0, claim: null, stakeID: 0, stake: null, pillar: null };
            this.cellCubes.set(key, rec);
        }
        if (rec.claimID !== claimVisualID) {
            this.safeDestroy(rec.claim);
            rec.claim = null;
            rec.claimID = 0;
            if (claimVisualID) {
                rec.claim = this.spawnLocal(this.getClaimVolumeFromPlayerID(claimVisualID),
                    x, this.cubeHeight(scale), z, new vec3(scale, scale, scale));
                if (rec.claim) rec.claimID = claimVisualID;
            }
        }
        if (rec.stakeID !== stakeVisualID) {
            this.safeDestroy(rec.stake);
            this.safeDestroy(rec.pillar);
            rec.stake = null;
            rec.pillar = null;
            rec.stakeID = 0;
            if (stakeVisualID) {
                const y = this.cubeHeight(scale);
                rec.stake = this.spawnLocal(this.getStakeVolumeFromPlayerID(stakeVisualID),
                    x, y, z, new vec3(scale, scale, scale));
                rec.pillar = this.spawnLocal(this.getStakePillarFromPlayerID(stakeVisualID),
                    x, y, z, new vec3(1, scale, 1));
                if (rec.stake || rec.pillar) rec.stakeID = stakeVisualID;
            }
        }
        if (!rec.claimID && !rec.stakeID) this.cellCubes.delete(key);
    }

    // Destroy that can never throw: skips null / already-destroyed natives and logs failures.
    private safeDestroy(obj: SceneObject | null): void {
        if (!obj || isNull(obj)) return;
        try {
            obj.destroy();
        } catch (e) {
            this.log("safeDestroy: " + e);
        }
    }

    // Legacy no-ops: only the unused single-player GridClaimer still calls these. The live
    // game draws cubes through setCellCubes.
    createWorldClaimVolume(_ID: number, _x: number, _y: number, _z: number, _scale: number): void {}
    createWorldStakeVolume(_ID: number, _x: number, _y: number, _z: number, _scale: number): void {}
    DestroyAllClaims(): void {}
    DestroyAllStakes(): void {}

    onAwake(){
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
        this.alignMiniMapCells();
        this.hideRespawnCountdown();
        // Guarded: display-only setup must not be able to abort onAwake.
        try {
            this.layoutLeaderboard();
            this.updateLeaderboard([], null, () => 0); // start with every row hidden
        } catch (e) {
            print("PlayerVisuals: leaderboard setup failed: " + e);
        }
    }

    // FEAT-2: builds the leaderboard once. Per row it styles the score Text and creates the
    // player-color square plus the larger white "this is you" square behind it (which shows as
    // a white outline). Squares on purpose — they echo the grid cells and reuse the minimap's
    // whiteCell texture, like the stake dots. Squares are siblings of the row Text (same parent,
    // same render layer). Positions come from positionLeaderboardRows; the Text rects authored
    // in the editor are overwritten, so their setup cannot break the layout.
    private layoutLeaderboard(): void {
        const rows = this.leaderboardRows;
        if (!rows || rows.length === 0) return;
        const canBuildSquares = !!this.cellMaterial && !!this.whiteCell;
        if (!canBuildSquares) {
            this.log("layoutLeaderboard: cellMaterial/whiteCell unassigned — leaderboard squares skipped");
        }

        for (let i = 0; i < rows.length; i++) {
            this.leaderboardDots[i] = null;
            this.leaderboardRings[i] = null;
            const row = rows[i];
            if (!row) continue;
            const rowObj = row.getSceneObject();
            if (i >= this.LEADERBOARD_ROW_COUNT) { // only 4 rows are ever driven — hide extras
                rowObj.enabled = false;
                continue;
            }

            // Text styling never depends on the squares. Score text is always white (identity
            // is carried by the square) and has no box behind it — a background would block the
            // 3D visuals (the scene Text objects were authored with Background enabled).
            row.textFill.color = new vec4(1, 1, 1, 1);
            row.backgroundSettings.enabled = false;
            row.verticalAlignment = VerticalAlignment.Center;
            row.horizontalAlignment = HorizontalAlignment.Left;

            const parentObj = rowObj.getParent();
            if (!canBuildSquares || !parentObj) continue;
            const make = (name: string): Image => {
                const obj = global.scene.createSceneObject(name + i);
                obj.setParent(parentObj);
                obj.layer = rowObj.layer; // draw on the same UI camera as the row text
                obj.createComponent("Component.ScreenTransform");
                const img = obj.createComponent("Component.Image") as Image;
                img.stretchMode = StretchMode.Stretch; // fill the rect (the texture is not square)
                img.mainMaterial = this.cellMaterial.clone();
                img.mainPass.baseTex = this.whiteCell;
                obj.enabled = false;
                return img;
            };
            // Ring first so the dot (created after it) renders on top.
            const ring = make("LeaderboardRing");
            ring.mainPass.baseColor = new vec4(1, 1, 1, 1);
            this.leaderboardRings[i] = ring;
            this.leaderboardDots[i] = make("LeaderboardDot");
        }
        this.positionLeaderboardRows();
    }

    // FEAT-2: writes the anchors of every row's squares and score Text from the leaderboard*
    // constants, in the parent's anchor space. Anchor units are not square on screen, so the
    // squares' anchor width is derived from their anchor height via the parent's current
    // world-per-anchor ratio. That ratio can change after onAwake (render target / camera
    // setup), so updateLeaderboard calls this again on each redraw; it rewrites anchors only
    // when the ratio actually changed.
    private positionLeaderboardRows(): void {
        const rows = this.leaderboardRows;
        if (!rows || rows.length === 0) return;
        let parentST: ScreenTransform | null = null;
        for (let i = 0; i < rows.length && !parentST; i++) {
            const p = rows[i] ? rows[i].getSceneObject().getParent() : null;
            parentST = p ? p.getComponent("Component.ScreenTransform") as ScreenTransform : null;
        }
        let xPerY = 1;
        if (parentST) {
            const w0 = parentST.localPointToWorldPoint(new vec2(0, 0));
            const w1 = parentST.localPointToWorldPoint(new vec2(1, 1));
            const perX = Math.abs(w1.x - w0.x);
            const perY = Math.abs(w1.y - w0.y);
            if (perX > 0 && perY > 0) xPerY = perY / perX;
        }
        if (Math.abs(xPerY - this.leaderboardXPerY) < 0.0001) return; // unchanged since last layout
        this.leaderboardXPerY = xPerY;

        const pitch = this.leaderboardRowPitch;
        const dotHalfH  = pitch * this.leaderboardDotScale / 2;
        const ringHalfH = dotHalfH * this.leaderboardRingScale;
        const ringHalfW = ringHalfH * xPerY;
        const cx = this.leaderboardLeft + ringHalfW;
        const textLeft = cx + ringHalfW + ringHalfW * 0.6;

        const place = (obj: SceneObject, l: number, r: number, t: number, b: number): void => {
            const st = obj.getComponent("Component.ScreenTransform") as ScreenTransform;
            if (!st) return;
            st.anchors.left = l; st.anchors.right = r;
            st.anchors.top = t;  st.anchors.bottom = b;
            st.offsets.left = 0; st.offsets.right = 0; st.offsets.top = 0; st.offsets.bottom = 0;
        };

        const count = Math.min(rows.length, this.LEADERBOARD_ROW_COUNT);
        for (let i = 0; i < count; i++) {
            const row = rows[i];
            if (!row) continue;
            // Row 3 (the local player's own score) sits an extra half row lower so it reads as
            // separate from the top three.
            const top = this.leaderboardTop - i * pitch - (i === 3 ? pitch * this.leaderboardOwnRowGap : 0);
            const cy = top - pitch / 2;
            const ring = this.leaderboardRings[i];
            const dot = this.leaderboardDots[i];
            if (ring) place(ring.getSceneObject(), cx - ringHalfW, cx + ringHalfW, cy + ringHalfH, cy - ringHalfH);
            if (dot) {
                const dotHalfW = dotHalfH * xPerY;
                place(dot.getSceneObject(), cx - dotHalfW, cx + dotHalfW, cy + dotHalfH, cy - dotHalfH);
            }
            // The score text's rect: just right of the outline, the same band as the square.
            place(row.getSceneObject(), textLeft, textLeft + this.leaderboardTextWidth, top, top - pitch);
        }
    }

    // FEAT-2: entries = all scoring players, highest first (Networker.getLeaderboard()).
    // Rows 0-2 show the top three: a square in the player's claim color + the score in white.
    // The local player's row is marked by a white outline around its square. When the local
    // player is outside the top three their own score gets a row of its own: the first free
    // top row if fewer than three players are scoring (they hold no cells), else row 3.
    // Called only on a change.
    updateLeaderboard(
        entries: { clientID: number, score: number }[],
        localClientID: number | null,
        getPlayerVisualID: (id: number) => number
    ): void {
        const rows = this.leaderboardRows;
        if (!rows || rows.length === 0) return;
        this.positionLeaderboardRows(); // no-op unless the screen aspect changed

        const count = Math.min(rows.length, this.LEADERBOARD_ROW_COUNT);
        const top = Math.min(3, count);
        const shown = Math.min(entries.length, top);
        let localInTop = false;
        for (let i = 0; i < shown; i++) {
            if (localClientID != null && entries[i].clientID === localClientID) localInTop = true;
        }

        // Which row (if any) carries the local player's own score.
        let ownRow = -1;
        if (localClientID != null && !localInTop) {
            if (shown < top) ownRow = shown;
            else if (count > 3) ownRow = 3;
        }
        let ownScore = 0; // holding no cells yet
        if (ownRow >= 0) {
            for (let i = 0; i < entries.length; i++) {
                if (entries[i].clientID === localClientID) { ownScore = entries[i].score; break; }
            }
        }

        for (let i = 0; i < count; i++) {
            if (i === ownRow) {
                this.setLeaderboardRow(i, "" + ownScore, getPlayerVisualID(localClientID as number), true);
            } else if (i < shown) {
                const e = entries[i];
                this.setLeaderboardRow(i, "" + e.score, getPlayerVisualID(e.clientID), e.clientID === localClientID);
            } else {
                this.setLeaderboardRow(i, null, 0, false);
            }
        }
    }

    // text === null hides row i (text, dot and ring). Writes only what changed (memoized on the
    // Text, like the minimap's __lastColor).
    private setLeaderboardRow(i: number, text: string | null, visualID: number, isLocal: boolean): void {
        const row = this.leaderboardRows[i];
        if (!row) return;
        const memo = row as any;
        const obj = row.getSceneObject();
        const dot = this.leaderboardDots[i];
        const ring = this.leaderboardRings[i];
        const dotObj = dot ? dot.getSceneObject() : null;
        const ringObj = ring ? ring.getSceneObject() : null;

        const visible = text !== null;
        if (obj.enabled !== visible) obj.enabled = visible;
        if (dotObj && dotObj.enabled !== visible) dotObj.enabled = visible;
        const ringOn = visible && isLocal;
        if (ringObj && ringObj.enabled !== ringOn) ringObj.enabled = ringOn;
        if (!visible) return;

        if (memo.__lastText !== text) {
            row.text = text;
            memo.__lastText = text;
        }
        if (dot && memo.__lastVisualID !== visualID) {
            const c = this.getPlayerClaimColor(visualID);
            // The player's claim color exactly as the minimap uses it (same RGB), so a row
            // matches that player's territory. Do not brighten it: a brightened P5 brown
            // reads as orange and no longer matches.
            dot.mainPass.baseColor = new vec4(c.x, c.y, c.z, 1.0); // opaque for legibility
            memo.__lastVisualID = visualID;
        }
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
