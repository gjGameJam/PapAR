//import {SessionController} from '../../SpectaclesSyncKit/Core/SessionController';
import { SessionController } from "SpectaclesSyncKit.lspkg/Core/SessionController";
import {StorageProperty} from "SpectaclesSyncKit.lspkg/Core/StorageProperty"
import {SyncEntity} from "SpectaclesSyncKit.lspkg/Core/SyncEntity"
import {SyncKitLogger} from "SpectaclesSyncKit.lspkg/Utils/SyncKitLogger"
import { PlayerVisuals } from './PlayerVisuals';

// TD-14: single source of truth for the respawn floor (seconds). LocationTracker's countdown
// duration derives from this, and Networker.onAwake() asserts the ghost window
// (RECENTLY_DEAD_TTL_MS) closes strictly before it — see the invariant note on that field.
export const RESPAWN_FLOOR_S = 3.0;

@component
export class Networker extends BaseScriptComponent {
    //to help debug — gated logging via this.log(); toggle in the Inspector
    @input
    showLogs: boolean = false;
    //connection id
    clientID: number;
    
    playerID: number; //equal to numbers of players (after self joined so p1 = 1, p2 = 2...)
    
    gridSyncEntity: SyncEntity;
    
    // Map to store individual cell storage properties
    private gridCells: Map<string, StorageProperty<vec2>> = new Map();
    
    // Map to store local cell state (for immediate reads before cloud sync)
    private localCellState: Map<string, vec2> = new Map();
    
    // Map to store cache timestamps for cleanup
    private localCacheTimestamps: Map<string, number> = new Map();
    
    private height = 40; //the length and width (in number of cells) of the grid cube
    
    private gridRadius = this.height / 2; //the radius is half of the diameter (the height & width of square)
    
    unitsPerCell: number = 200;//cells size in centimeters (also in gridclaimer which is getting phased out)
    
    private lastIdx = this.height * this.height; //last index in the grid (square of that is height tall and height wide)
    
    gridReady = false; //flag for grid being ready to use
    
    private firstClaim = true; //flag to create home claim on start
    
    private isPerformingBulkConversion = false; //flag to prevent multiple bulk conversions

    // NET-3/D3: monotonic counter bumped on death and at conversion-start. In-flight conversion
    // chains, the delayed 500ms stake write, and in-flight STAKE-volume spawns capture it and
    // self-abort when it changes, so a death (or a superseding conversion) invalidates work
    // scheduled by a prior life/batch — even across a respawn, where isAlive flips back to true.
    private conversionEpoch = 0;

    // F1/NET-11: monotonic counter bumped ONLY on local death (next to conversionEpoch++).
    // In-flight CLAIM-volume spawns capture it and self-destroy in onSuccess if it changed.
    // Claims need their own epoch: conversionEpoch also bumps at conversion-start, which would
    // wrongly destroy batch N's still-in-flight claim visuals the moment batch N+1 starts.
    private deathEpoch = 0;

    // F2/NET-12: clientID -> ghost-window deadlines, opened by handlePlayerDeath on every death.
    // serverDeadline is server-time ms (receipt + TTL), matched against a remote write's
    // sentServerTimeMilliseconds — arrival skew, not clock skew, is the hazard: a ghost write
    // SENT inside the window must be cleared no matter how late it lands, and a write SENT after
    // the window (e.g. the respawned home claim) must survive no matter how fast it arrives.
    // localDeadline is the Date.now() fallback for when the session clock is unavailable.
    // Entries are never removed (bounded by deaths per session).
    private recentlyDead: Map<number, { serverDeadline: number | null, localDeadline: number }> = new Map();

    // F2: clients that left the session. Leave-ghosts are the durable ones — the leaver's device
    // is gone and can't self-clean — so cell/slot values naming a departed client are cleared on
    // sight (interceptors + seed-check) with no time window. Removed again on rejoin.
    private departedClients: Set<number> = new Set();

    // NET-17/TD-11: presence cache — clientIDs of currently-connected users. Maintained by the
    // join/leave handlers (which already derive the hash), seeded from getUsers() at grid-ready,
    // and backfilled by isClientPresent's fallback scan. Consulting this Set first means presence
    // no longer re-hashes every displayName per query, and a transiently blank displayName in
    // getUsers() can't make an already-seen player read as absent (which would let the kill gate
    // erase their live stake, or a leave re-sweep destroy a rejoined player's new visuals).
    private presentClientIDs: Set<number> = new Set();

    // F4/NET-15: deaths that arrived before gridReady (the RPC channel subscribes at construction,
    // so death events CAN land while the grid entity is still initializing). Replayed — bounded —
    // in notifyOnReady, right after the color slots are seeded.
    private pendingDeathCleanups: { id: number, hint: number | undefined, isLeave: boolean, queuedAt: number }[] = [];

    // F2: how long after a death the ghost interceptors treat writes SENT within the window as
    // remnants of the dead life. MUST stay under the RESPAWN_FLOOR_S respawn floor (which
    // LocationTracker.respawnDuration derives from) — at TTL >= respawn, the interceptor would
    // eat the respawned player's fresh home claim (soft-lock: firstClaim consumed, claim gone).
    // TD-14: not readonly so the onAwake() invariant check can clamp a bad edit instead of
    // running broken.
    private RECENTLY_DEAD_TTL_MS = 2000;

    // F1: leave-path re-sweep delays (seconds), catching volumes whose createRealtimeStore
    // round-trip was still in flight when the leave cleanup ran. Leave-only: kill victims stay
    // connected and their own epoch-gated onSuccess self-cleans.
    private readonly LEAVE_RESWEEP_DELAYS_S = [2.0, 8.0];

    // NET-5 (leave residual): write pacing for the full-store leave sweep. The collect pass is
    // local reads only (free); heals are written in chunks so a pathological territory
    // (~1600 cells) can't burst-flood the realtime backend from every remaining client in one
    // frame. Matches the 40-50ms pacing philosophy of the conversion/interior chains. Typical
    // territories (tens of cells) complete in the first synchronous chunk.
    private readonly STORE_SWEEP_CHUNK = 40;
    private readonly STORE_SWEEP_CHUNK_DELAY_S = 0.05;
    
    //player visuals script for minimap and world objects
    @input
    PlayerVisuals: PlayerVisuals;
    
    stakeList: vec2[] = []; //keep track of stake cells (in order)
    
    isAlive = true; //keep track of alive status of self

    private playerColorSlots: StorageProperty<vec2>[] = [];
    private pendingColorWrite: boolean = false;

    deathEventString = 'playerDeathEvent';

    // Event-driven minimap: track the current 5x5 window center and a dirty flag so the minimap
    // only redraws when the player crosses a cell boundary (window shifts) OR a cell inside the
    // window changes value (local write or remote cloud update) — instead of re-reading and
    // re-coloring 25 cells on every 0.1s tick.
    private miniMapCenterX = NaN; // NaN = uninitialized -> forces the first redraw once ready
    private miniMapCenterY = NaN;
    private miniMapDirty = false;
    
    //script to manager the grid claim modification permissions
    onAwake() {
        // TD-14: hard invariant — the ghost window must close before the earliest possible
        // respawn, or every respawned home claim would be SENT inside its author's own
        // recently-dead window and eaten by the ghost interceptors on every client (total
        // gameplay breakage). Clamp and print unconditionally (a build config error, not a
        // debug log) rather than run broken.
        if (this.RECENTLY_DEAD_TTL_MS >= RESPAWN_FLOOR_S * 1000) {
            const clamped = Math.max(0, RESPAWN_FLOOR_S * 1000 - 1000);
            print("NetworkerV2: CONFIG ERROR - RECENTLY_DEAD_TTL_MS (" + this.RECENTLY_DEAD_TTL_MS
                + "ms) must stay under the respawn floor (" + (RESPAWN_FLOOR_S * 1000)
                + "ms); clamping to " + clamped + "ms");
            this.RECENTLY_DEAD_TTL_MS = clamped;
        }

        // Create new sync entity for this script
        this.gridSyncEntity = new SyncEntity(this);

        if (this.showLogs) {
            this.log("NetworkerV2: Sync entity created")
        }

        // Set up the sync entity notify on ready callback
        this.gridSyncEntity.notifyOnReady(() => {
            this.log("NetworkerV2: SyncEntity ready")
            this.gridReady = true;

            // NET-17/TD-11: seed the presence cache from the live user list — users who joined
            // before our onUserJoinedSession handler could see them.
            this.seedPresentClients();

            // Initialize all grid cells as individual storage properties
            this.initializeGridCells();

            // F4: replay deaths that arrived while the grid entity was initializing — the color
            // slots were just seeded synchronously by addStorageProperty, so slot-frees work now.
            this.replayPendingDeathCleanups();
        });

        // All clients handle death cleanup, not just the dying player's device
        this.gridSyncEntity.onEventReceived.add(this.deathEventString, (messageInfo) => {
            const deathData = messageInfo.data as vec3;
            const deadPlayerID = deathData.x;
            const killerID = deathData.y;
            // F3/NET-14: the victim's color index rides in the payload so the remote sweep's
            // prefix fallback never depends on a color slot every client is about to zero.
            const victimVisualID = deathData.z;

            // F2: clientID 0 collides with the "unclaimed" sentinel — never process it
            // (see the matching guard in handlePlayerDeath).
            if (!deadPlayerID) {
                this.log("NetworkerV2: Ignoring death event for clientID 0");
                return;
            }

            this.log("NetworkerV2: Death event — player " + deadPlayerID + " killed by " + killerID + " (self=" + this.clientID + ")");
            // F4/NET-15: RPCs can land before gridReady. Run what works now (the visual sweep
            // needs no grid state) and queue a bounded replay for the slot-free once the slots
            // are seeded in notifyOnReady.
            if (!this.gridReady) {
                this.pendingDeathCleanups.push({ id: deadPlayerID, hint: victimVisualID, isLeave: false, queuedAt: Date.now() });
            }
            this.handlePlayerDeath(deadPlayerID, victimVisualID);
        });

        // When a player leaves, treat it as death-by-self on all remaining clients
        SessionController.getInstance().onUserLeftSession.add((_session, userInfo) => {
            if (!userInfo.displayName) {
                this.log("NetworkerV2: Player left with null display name, skipping cleanup");
                return;
            }
            const leftClientID = this.computeClientID(userInfo.displayName);
            if (leftClientID === 0) {
                this.log("NetworkerV2: Leaving player hashes to clientID 0 (null-name collision), skipping cleanup");
                return;
            }
            this.log("NetworkerV2: Player left: " + userInfo.displayName + " (clientID=" + leftClientID + ")");
            // F3: resolve the leaver's visual hint BEFORE handlePlayerDeath zeroes their slot.
            // Pre-gridReady the slots are empty and the (id % 5) || 5 fallback is garbage —
            // leave the hint unset there; owner-key matching covers the sweep regardless.
            const hint = this.gridReady ? this.getPlayerVisualID(leftClientID) : undefined;
            // NET-17/TD-11: drop from the presence cache BEFORE the cleanup below runs, so
            // isClientPresent correctly reads them as absent throughout.
            this.presentClientIDs.delete(leftClientID);
            // F2: leave-ghosts can't self-clean (the leaver's device is gone) — remember the
            // departure so the interceptors and seed-checks clear anything still naming them.
            this.departedClients.add(leftClientID);
            // F4: queue a bounded replay for once the grid (and the color slots) are ready.
            if (!this.gridReady) {
                this.pendingDeathCleanups.push({ id: leftClientID, hint: undefined, isLeave: true, queuedAt: Date.now() });
            }
            this.handlePlayerDeath(leftClientID, hint);
            // NET-5: leaving must equal dying EVERYWHERE — purge the leaver's cells from the
            // whole cloud store, including regions no remaining client has subscribed (late
            // joiners never learn of the leave, so present clients must heal the store itself).
            // After handlePlayerDeath so Phase 3 has run and the subscribed/unsubscribed split
            // is stable. No-op pre-gridReady (the F4 replay runs it once the store is ready).
            try {
                this.sweepStoreForDepartedClient(leftClientID);
            } catch (e) {
                this.log("NetworkerV2: ERROR in leave store sweep for " + leftClientID + ": " + e);
            }
            // F1: leaves are permanent deaths (no respawn can collide) — schedule late re-sweeps
            // for volumes whose createRealtimeStore round-trip spanned this cleanup.
            this.scheduleLeaveResweeps(leftClientID, hint);
        });

        // F2: a rejoining player is no longer departed — their new writes and slot claim must
        // not be treated as ghosts, and queued leave-replays skip present players (F4).
        SessionController.getInstance().onUserJoinedSession.add((_session, userInfo) => {
            if (!userInfo.displayName) return;
            const joinedClientID = this.computeClientID(userInfo.displayName);
            if (joinedClientID === 0) return;
            // NET-17/TD-11: track presence by clientID (the hash is already computed here).
            this.presentClientIDs.add(joinedClientID);
            // NET-16: a rejoiner's ghost window must not outlive their return — without this
            // delete, their fresh writes inside the 2s TTL (home claim, first stakes) would
            // still be ghost-cleared by every client, soft-locking their new life.
            this.recentlyDead.delete(joinedClientID);
            if (this.departedClients.has(joinedClientID)) {
                this.departedClients.delete(joinedClientID);
                this.log("NetworkerV2: Player rejoined: " + userInfo.displayName + " (clientID=" + joinedClientID + ") — cleared departed status");
            }
        });
    }
    
    // Initialize grid cells as individual storage properties
    private initializeGridCells() {
        if (this.showLogs) {
            this.log("NetworkerV2: Initializing grid cells as individual storage properties");
        }
        
        // Only initialize cells as needed (lazy initialization)
        // This avoids creating 1600 storage properties at once
        if (this.showLogs) {
            this.log("NetworkerV2: Grid cells will be initialized on-demand");
        }

        for (let i = 1; i <= 5; i++) {
            const slot = StorageProperty.manualVec2(`playerColorSlot_${i}`, vec2.zero());
            this.playerColorSlots.push(slot);
            this.gridSyncEntity.addStorageProperty(slot);
            // F2: slot interceptor — a slot claim arriving from a player who has died/left (and
            // is not present) would otherwise leak that color for the whole session (the leaver
            // can't self-clean and everyone's slot-free already ran). Zero it on arrival.
            slot.onAnyChange.add((newVal: vec2, _oldVal: vec2, updateInfo) => {
                this.interceptGhostSlotWrite(slot, newVal, updateInfo);
            });
        }

        if (this.pendingColorWrite) {
            this.pendingColorWrite = false;
            this.assignAndWritePlayerID();
        }
    }
    
    // Get or create a cell storage property
    private getCellProperty(x: number, y: number): StorageProperty<vec2> | null {
        const key = this.getCellKey(x, y);
        
        // Check if property already exists
        if (this.gridCells.has(key)) {
            if (this.showLogs) this.log("NetworkerV2: CELL REUSE - Using existing property for cell (" + x + ", " + y + ")");
            return this.gridCells.get(key);
        }

        if (this.showLogs) this.log("NetworkerV2: CELL CREATE - Creating new property for cell (" + x + ", " + y + ")");
        
        // Create new storage property for this cell
        const cellProp = StorageProperty.manualVec2(key, vec2.zero());
        
        // Add to sync entity
        this.gridSyncEntity.addStorageProperty(cellProp);
        
        // Store in map
        this.gridCells.set(key, cellProp);
        
        // Add change listener for this cell
        cellProp.onAnyChange.add((newVal: vec2, oldVal: vec2, updateInfo) => {
            this.log("NetworkerV2: CELL CHANGE DETECTED - Cell (" + x + ", " + y + "):");

            // Handle potentially null values
            const oldClaimed = oldVal ? oldVal.x : 0;
            const oldStaked = oldVal ? oldVal.y : 0;
            const newClaimed = newVal ? newVal.x : 0;
            const newStaked = newVal ? newVal.y : 0;

            this.log("  OLD VALUE: claimed=" + oldClaimed + ", staked=" + oldStaked + " (was " + (oldVal ? "valid" : "null") + ")");
            this.log("  NEW VALUE: claimed=" + newClaimed + ", staked=" + newStaked + " (is " + (newVal ? "valid" : "null") + ")");

            // Cloud is now authoritative — always clear local cache on any cloud update.
            // Previously this only cleared when cloud value matched local cache (to detect
            // our own write confirmation). But if another player overwrites our pending write,
            // onAnyChange fires with THEIR value, which doesn't match ours, so the stale
            // local entry persisted and the minimap never updated for the overwritten player.
            const cellKey = this.getCellKey(x, y);
            if (this.localCellState.has(cellKey)) {
                this.localCellState.delete(cellKey);
                this.localCacheTimestamps.delete(cellKey);
                this.log("  🧹 LOCAL CACHE CLEARED - Cloud update received (cloud authoritative)");
            }

            // Special logging for stake-to-claim conversions (with null safety)
            if (oldStaked !== 0 && newStaked === 0 && newClaimed !== 0) {
                this.log("  ✓✓✓ STAKE SUCCESSFULLY CONVERTED TO CLAIM ✓✓✓");
            }

            // Event-driven minimap: a cloud update to a cell inside the current window dirties the
            // map so the next tick redraws it (covers REMOTE players' stakes/claims/conversions).
            if (this.isWithinMiniMapWindow(x, y)) {
                this.miniMapDirty = true;
            }

            // F2/NET-12 ghost interceptor: a value naming a recently-dead (sent inside their
            // window) or departed player is a stale remnant of that life — clear it immediately.
            this.interceptGhostCellWrite(x, y, newVal, updateInfo);
        });

        if (this.showLogs) this.log("NetworkerV2: Total cells in map: " + this.gridCells.size);

        // F2 seed-check: values seeded by addStorageProperty (silentSetCurrentValue) fire NO
        // events, so a ghost value already sitting in the cloud store is only ever caught here,
        // at first subscription. This is what heals a leaver's cells for players who walk near
        // them later (narrows NET-5 for leave-ghosts). Safe from recursion: the property is
        // already in gridCells, so the interceptor's updateCellValue re-uses it.
        const seeded = cellProp.currentValue;
        if (seeded && (seeded.x !== 0 || seeded.y !== 0)) {
            this.interceptGhostCellWrite(x, y, seeded, null);
        }

        return cellProp;
    }
    
    // Generate unique key for cell coordinates
    private getCellKey(x: number, y: number): string {
        return `cell_${x}_${y}`;
    }
    
    // Helper method to update both cloud storage and local state
    private updateCellValue(x: number, y: number, newValue: vec2, description: string = ""): boolean {
        const cellKey = this.getCellKey(x, y);
        const cellProp = this.getCellProperty(x, y);
        
        if (!cellProp) {
            this.log("NetworkerV2: ERROR - Could not update cell (" + x + ", " + y + ") - no property");
            return false;
        }
        
        // For critical operations like bulk conversions, use setValueImmediate when possible
        if (this.gridSyncEntity.canIModifyStore() && (description.includes("CONVERSION") || description.includes("INTERIOR"))) {
            this.log("NetworkerV2: CRITICAL OPERATION - Using setValueImmediate for " + description);
            cellProp.setValueImmediate(this.gridSyncEntity.currentStore, newValue);
            this.log("NetworkerV2: CLOUD IMMEDIATE - Cell (" + x + ", " + y + ") " + description + ": claimed=" + newValue.x + ", staked=" + newValue.y);
        } else {
            // Use setPendingValue for normal operations
            cellProp.setPendingValue(newValue);
            this.log("NetworkerV2: CLOUD PENDING - Cell (" + x + ", " + y + ") " + description + ": claimed=" + newValue.x + ", staked=" + newValue.y);
        }
        
        // ALSO update local state for immediate reads (ensures consistency until cloud sync)
        this.localCellState.set(cellKey, newValue);
        this.localCacheTimestamps.set(cellKey, Date.now()); // Track when we cached this
        this.log("NetworkerV2: LOCAL CACHED - Cell (" + x + ", " + y + ") for immediate reads");

        // Event-driven minimap: a LOCAL write to a cell inside the current window dirties the map
        // immediately, so our own stakes/claims/interior fills show without waiting for the cloud
        // round-trip (onAnyChange) to fire.
        if (this.isWithinMiniMapWindow(x, y)) {
            this.miniMapDirty = true;
        }

        return true;
    }
    
    setPlayerID(passedID: number): void {
        this.clientID = passedID;
        this.log("NetworkerV2: client ID set to: " + this.clientID);
        if (this.gridReady) {
            this.assignAndWritePlayerID();
        } else {
            this.pendingColorWrite = true;
        }
    }

    // Scans color slots to assign a stable playerID (1-5).
    // Rejoining players find their own slot and reuse it without writing.
    // New players claim the first empty slot, seeded by clientID to reduce simultaneous-join collisions.
    private assignAndWritePlayerID(): void {
        for (let i = 0; i < this.playerColorSlots.length; i++) {
            const val = this.playerColorSlots[i].currentValue;
            if (val && val.x === this.clientID) {
                this.playerID = val.y;
                this.log("NetworkerV2: Rejoining — reusing playerID=" + this.playerID + " from slot " + i);
                return;
            }
        }
        const startIdx = this.clientID % this.playerColorSlots.length;
        for (let offset = 0; offset < this.playerColorSlots.length; offset++) {
            const i = (startIdx + offset) % this.playerColorSlots.length;
            const val = this.playerColorSlots[i].currentValue;
            if (!val || val.x === 0) {
                this.playerID = i + 1;
                this.playerColorSlots[i].setPendingValue(new vec2(this.clientID, this.playerID));
                this.log("NetworkerV2: New player — claiming slot " + i + ", playerID=" + this.playerID);
                return;
            }
        }
        // NET-7: All 5 slots occupied (6+ players, none ours). Do NOT overwrite an active player's
        // slot — that corrupts their color mapping on every client. Instead take a shared fallback
        // color locally and skip the cloud write. getPlayerVisualID() derives the same
        // (clientID % 5) || 5 for any player with no slot, so remote coloring stays consistent.
        // Known tradeoff (accepted): this 6th+ player shares a COLOR with an active player. Their
        // death no longer destroys the co-colored player's cubes, though — death sweeps match the
        // "_papar_owner" clientID stamped on every spawn (F3), not the shared "P{n}" prefab prefix.
        this.playerID = (this.clientID % 5) || 5;
        this.log("NetworkerV2: All slots full — shared fallback color playerID=" + this.playerID + " (no slot write)");
    }

    getPlayerVisualID(clientID: number): number {
        if (clientID === this.clientID && this.playerID) return this.playerID;
        for (let i = 0; i < this.playerColorSlots.length; i++) {
            const val = this.playerColorSlots[i].currentValue;
            if (val && val.x === clientID) return val.y;
        }
        return (clientID % 5) || 5;
    }

    getCellDataReadOnly(x: number, y: number): vec2 {
        const key = `cell_${x}_${y}`;
        const cached = this.localCellState.get(key);
        if (cached) return cached;
        const prop = this.gridCells.get(key);
        if (prop) {
            const val = prop.currentValue;
            return (val && !isNaN(val.x)) ? val : vec2.zero();
        }
        return vec2.zero();
    }

    // True when (x, y) is inside the current 5x5 minimap window. Returns false until the window
    // has been established (center is NaN before the first getMiniMapCells snapshot).
    private isWithinMiniMapWindow(x: number, y: number): boolean {
        if (isNaN(this.miniMapCenterX)) return false;
        return Math.abs(x - this.miniMapCenterX) <= 2 && Math.abs(y - this.miniMapCenterY) <= 2;
    }

    // Center cell of the last-drawn 5x5 window (grid coords), or null before the first draw.
    // Lets the arrow's sub-cell offset wrap at the exact tick the window re-centers, so the
    // arrow stays glued to the map content instead of flicking a cell ahead of the redraw.
    getMiniMapWindowCenter(): vec2 | null {
        if (isNaN(this.miniMapCenterX)) return null;
        return new vec2(this.miniMapCenterX, this.miniMapCenterY);
    }

    // Cheap per-tick guard for LocationTracker: redraw only when the window has never been drawn,
    // the player crossed into a new cell (window shifts), or a windowed cell changed value.
    shouldRedrawMiniMap(centerX: number, centerY: number): boolean {
        return isNaN(this.miniMapCenterX)
            || centerX !== this.miniMapCenterX
            || centerY !== this.miniMapCenterY
            || this.miniMapDirty;
    }

    getMiniMapCells(centerX: number, centerY: number): (vec2 | null)[] {
        // Guard: only subscribe to cells once the SyncEntity is ready.
        // addStorageProperty must be called on a ready entity for silentSetCurrentValue
        // to load existing cloud values into currentValue. Properties subscribed before
        // ready stay at vec2.zero() permanently (not retroactively initialized).
        // Leaves the window center uninitialized so shouldRedrawMiniMap keeps returning true
        // (retrying every tick) until the grid is ready.
        if (!this.gridReady) return new Array(25).fill(vec2.zero());
        const result: (vec2 | null)[] = [];
        const radius = 2;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const gx = centerX + dx;
                const gy = centerY + dy;
                if (gx >= 0 && gx < this.height && gy >= 0 && gy < this.height) {
                    // getCellProperty registers a StorageProperty with the SyncEntity,
                    // which is required for remote updates to this cell to arrive.
                    const prop = this.getCellProperty(gx, gy);
                    const key = this.getCellKey(gx, gy);
                    const cached = this.localCellState.get(key);
                    const cacheAge = cached ? (Date.now() - (this.localCacheTimestamps.get(key) || 0)) : Infinity;
                    if (cached && cacheAge < 5000) {
                        result.push(cached);
                    } else if (prop) {
                        // Use currentValue: set by silentSetCurrentValue on addStorageProperty (initial
                        // store read) and by applyRemoteValue on all subsequent remote updates.
                        // currentOrPendingValue is NOT set by silentSetCurrentValue, so it stays
                        // vec2.zero() from the constructor and would always show unclaimed.
                        const val = prop.currentValue;
                        result.push((val && !isNaN(val.x)) ? val : vec2.zero());
                    } else {
                        result.push(vec2.zero());
                    }
                } else {
                    result.push(null);
                }
            }
        }
        // Record the window we just snapshotted and clear the dirty flag. Set at the END so any
        // onAnyChange that fired while subscribing new cells above is already captured in `result`;
        // the next redraw is then driven purely by a center change or a fresh windowed-cell change.
        this.miniMapCenterX = centerX;
        this.miniMapCenterY = centerY;
        this.miniMapDirty = false;
        return result;
    }

    
    //this function is called whenever self moves into a cell
    //function to update grid data (grid cell is vec2 representing claim and stake owner(s))
    sendData(ID: number, xpos: number, zpos: number, realWorldCoords: vec3) {
        //if player is dead, return early (they can't stake, claim, or kill)
        if (!this.isAlive){
            return;
        }
        
        // Block updates during bulk conversion to prevent race conditions
        if (this.isPerformingBulkConversion) {
            if (this.showLogs) {
                this.log("NetworkerV2: Skipping sendData during bulk conversion");
            }
            return;
        }
        
        if (!this.gridReady) {
            if (this.showLogs) {
                this.log("NetworkerV2: SEND - Grid not ready, cannot send");
            }
            return;
        }
        
        // Get the cell property for this position
        const cellProp = this.getCellProperty(xpos, zpos);
        if (!cellProp) {
            this.log("NetworkerV2: ERROR - Could not get/create cell property");
            return;
        }
        
        // Get current value of this specific cell (check local state first for immediate consistency).
        // Use currentValue (not currentOrPendingValue): silentSetCurrentValue (called by
        // addStorageProperty when the key already exists in the cloud) sets currentValue but
        // NOT currentOrPendingValue, so currentOrPendingValue would read vec2.zero() for any
        // cell that was staked/claimed before this client subscribed.
        const cellKey = this.getCellKey(xpos, zpos);
        const currentCellValue = this.localCellState.has(cellKey)
            ? this.localCellState.get(cellKey)
            : (cellProp.currentValue || vec2.zero());

        //special/base case of creating home claim on start
        if (this.firstClaim == true){
            // NET-10: never write the home claim over an occupied cell — a co-located join
            // would silently erase another player's claim (and ignore their stake). Keep
            // firstClaim armed and defer to the next cell entry, mirroring the respawn "open
            // ground" rule (same predicate the respawn countdown uses). Also the NET-8
            // write-instant re-check for the respawn claim. Ghost values don't wedge this:
            // a departed player's stale cell was healed at subscription (seed-check) before
            // this read, and a kill victim's stale cell clears within ~1 RTT via their sweep.
            if (!this.isLegalSpawnCell(xpos, zpos)) {
                this.log("NetworkerV2: SEND - home claim deferred: cell (" + xpos + ", " + zpos + ") is occupied or out of bounds");
                return;
            }
            this.log("NetworkerV2: SEND - creating home claim with cloud storage");
            //set first claim to false to not allow multiple home claims
            this.firstClaim = false;

            //home claim is claimed by self and staked by none
            const homeClaimVal = new vec2(ID, 0);

            // Use helper method to update both local state and cloud storage
            this.updateCellValue(xpos, zpos, homeClaimVal, "HOME CLAIM");

            //calculate the center of current cell for visuals
            const cellCenterCoords = this.gridPosToWorldCoords(xpos, zpos);
            //create visual for claim
            this.PlayerVisuals.createWorldClaimVolume(this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell, this.clientID, this.claimSpawnValidity());
            return;//can return early now that backend and frontend home claim tasks are handled
        }

        //use current data at current index to determine next step
        const claimedBy = currentCellValue.x;
        let stakedBy = currentCellValue.y;

        this.log("NetworkerV2: new cell is claimed by " + claimedBy + " and staked by " + stakedBy)

        // F5 kill gate: a stake whose owner is no longer in the session is a ghost trail (e.g. a
        // leaver's pending write that outraced the death-clear). Firing the death RPC for it would
        // detonate the full cleanup machinery against that clientID — and clientIDs are stable
        // across lives, so if that player rejoined it would tear down their LIVE session (owner-key
        // sweep, recently-dead window, slot free). Instead treat the stake as stale: clear it and
        // fall through to the normal decision tree (the ghost self-heals into our stake/claim).
        // Present players are unchanged — including ourselves (self-collision, NET-9) and
        // dead-but-respawning victims (idempotent re-death).
        if (stakedBy != 0 && !this.isClientPresent(stakedBy)) {
            this.log("NetworkerV2: ghost stake by absent player " + stakedBy + " at (" + xpos + ", " + zpos + ") — clearing instead of killing");
            stakedBy = 0;
            if (claimedBy == ID) {
                // The conversion branch below won't rewrite this cell — heal the ghost explicitly.
                this.updateCellValue(xpos, zpos, new vec2(claimedBy, 0), "GHOST STAKE CLEAR");
            }
            // else: the stake write below overwrites the stake component anyway.
        }

        //if staked by a player (will be 0 if not staked)
        if (stakedBy != 0){
            // Broadcast kill to all clients — every client runs the victim's cleanup.
            // F3/NET-14: vec3 payload carries the victim's visualID so remote sweeps' prefix
            // fallback doesn't depend on a color slot every client is about to zero.
            this.gridSyncEntity.sendEvent(this.deathEventString, new vec3(stakedBy, this.clientID, this.getPlayerVisualID(stakedBy)));

            // If the stake belongs to a different player (not our own trail), stake the cell ourselves.
            // We don't call updateCellValue immediately here because the dead player's handlePlayerDeath
            // writes a cloud-clear (vec2(claimedBy, 0)) for all their staked cells. That clear travels
            // killer→network→dead client→network→cloud, so it arrives at the cloud server AFTER our
            // immediate setPendingValue and overwrites our stake.
            // Fix: write to localCellState and spawn the visual immediately (so the player sees it
            // and the minimap shows it), then delay the cloud write by 500ms so our write arrives
            // last and wins the race against the dead player's clear.
            if (stakedBy !== this.clientID) {
                const newCellValue = new vec2(claimedBy, ID);
                const cellCenterCoords = this.gridPosToWorldCoords(xpos, zpos);

                this.stakeList.push(new vec2(xpos, zpos));

                // Immediate local cache update — minimap reads this before cloud confirms
                this.localCellState.set(cellKey, newCellValue);
                this.localCacheTimestamps.set(cellKey, Date.now());

                // Spawn the world visual right away
                this.PlayerVisuals.createWorldStakeVolume(
                    this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell,
                    this.clientID, this.stakeSpawnValidity()
                );

                // Delayed cloud write wins the race against the dead player's death-clear writes.
                // D3: capture the epoch now and only write if it's unchanged when the timer fires.
                // A conversion (we looped back to our claim) or our own death bumps the epoch, so a
                // stale write can't revert a just-converted claim back to a stake, nor write a stake
                // for a now-dead player. If neither happened, the epoch matches and the write proceeds.
                const writeEpoch = this.conversionEpoch;
                const delayedWrite = this.createEvent("DelayedCallbackEvent");
                delayedWrite.bind(() => {
                    if (this.conversionEpoch === writeEpoch) {
                        this.updateCellValue(xpos, zpos, newCellValue, "STAKE");
                    } else {
                        this.log("NetworkerV2: dropped stale delayed stake write at (" + xpos + ", " + zpos + ") — epoch changed");
                    }
                    this.removeEvent(delayedWrite); // one-shot: drop it so events don't accumulate unbounded
                });
                delayedWrite.reset(0.5); // 500ms — enough for death-clear to propagate
            }
        }
        //if claim is by self (ID param) claim any staked area
        else if (claimedBy == ID){
            //check for any staked region and convert stakes to claims
            this.addStakedRegionToClaim(realWorldCoords);
        }
        //if claim is not by self (or unclaimed), stake cell
        else {
            //stake any cell not claimed by self
            const newCellValue = new vec2(claimedBy, ID); // Keep claim, update stake

            this.stakeList.push(new vec2(xpos, zpos)); //add to stakeloop

            // Use helper method to update both local state and cloud storage
            this.updateCellValue(xpos, zpos, newCellValue, "STAKE");

            //create player visual for newly staked cell at center of cell and at current y
            const cellCenterCoords = this.gridPosToWorldCoords(xpos, zpos);
            this.PlayerVisuals.createWorldStakeVolume(this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell, this.clientID, this.stakeSpawnValidity());
        }
        
        if (this.showLogs) {
            this.log("NetworkerV2: SEND - Successfully updated cell (" + xpos + ", " + zpos + ")");
        }
    }
    
    // function for accessing grid data
    getData(ID: number, xpos: number, zpos: number): vec2 {
        this.log("NetworkerV2: getData() called with ID=" + ID + ", xpos=" + xpos + ", zpos=" + zpos);
        
        // Always return a valid vec2, never undefined
        const fallbackVec = vec2.zero();
        
        try {
            if (!this.gridReady) {
                this.log("NetworkerV2: GET - Grid not ready, returning zero vec2");
                return fallbackVec;
            }
            
            this.log("NetworkerV2: GET REQUEST - Retrieving cell (" + xpos + ", " + zpos + ")");
            
            const cellKey = this.getCellKey(xpos, zpos);
            
            // FIRST: Check local state for immediate updates (handles race condition during bulk conversions)
            if (this.localCellState.has(cellKey)) {
                const cacheTimestamp = this.localCacheTimestamps.get(cellKey) || 0;
                const cacheAge = Date.now() - cacheTimestamp;
                
                // Use cache if it's fresh (less than 5 seconds old)
                if (cacheAge < 5000) {
                    const localValue = this.localCellState.get(cellKey);
                    this.log("NetworkerV2: ✅ GET LOCAL CACHE - Cell (" + xpos + ", " + zpos + "): claimed=" + localValue.x + ", staked=" + localValue.y + " (age: " + cacheAge + "ms)");
                    return localValue;
                } else {
                    // Cache is stale, remove it and fall through to cloud storage
                    this.log("NetworkerV2: 🗑️ STALE CACHE REMOVED - Cell (" + xpos + ", " + zpos + ") cache age: " + cacheAge + "ms");
                    this.localCellState.delete(cellKey);
                    this.localCacheTimestamps.delete(cellKey);
                }
            }
            
            const cellProp = this.getCellProperty(xpos, zpos);
            if (!cellProp) {
                this.log("NetworkerV2: ERROR - Could not get cell property, returning zero vec2");
                return fallbackVec;
            }

            let cellVec = cellProp.currentValue;
            if (!cellVec) {
                this.log("NetworkerV2: WARNING - Cell has no value, returning zero vec2");
                cellVec = fallbackVec;
            }
            
            // Ensure we have a valid vec2
            if (typeof cellVec.x === 'undefined' || typeof cellVec.y === 'undefined') {
                this.log("NetworkerV2: ERROR - Invalid vec2 structure, returning zero vec2");
                this.log("NetworkerV2: cellVec type: " + typeof cellVec + ", value: " + cellVec);
                return fallbackVec;
            }
            
            this.log("NetworkerV2: GET CLOUD - Cell (" + xpos + ", " + zpos + "): claimed=" + cellVec.x + ", staked=" + cellVec.y);
            
            // Log if this is a problematic stake that should have been converted
            if (cellVec.y === ID) {
                this.log("  ⚠️ WARNING: Cell is still staked by player " + ID + " - Cloud storage may not have persisted yet!");
            }
            
            this.log("NetworkerV2: Returning valid vec2: " + cellVec);
            return cellVec;
            
        } catch (error) {
            this.log("NetworkerV2: EXCEPTION in getData(): " + error);
            this.log("NetworkerV2: Returning fallback zero vec2");
            return fallbackVec;
        }
    }
    
    //returns index for gridata of the x and z coordinates of the grid (parameters)
    coordsToIndex(xCoord: number, zCoord: number): number {
        return this.height * zCoord + xCoord;
    }
    
    // Helper to convert index back to coordinates
    indexToCoords(index: number): vec2 {
        const z = Math.floor(index / this.height);
        const x = index % this.height;
        return new vec2(x, z);
    }
    
    // Converts grid position back to world coordinates (center of the cell)
    gridPosToWorldCoords(col: number, row: number): vec2 {
        const signedCol = col - this.gridRadius;
        const signedRow = row - this.gridRadius;
        const x = signedCol * this.unitsPerCell;
        const z = signedRow * this.unitsPerCell;
        return new vec2(x, z);
    }
    
    //function for handling player death — runs on ALL clients for kills (RPC), leaves
    //(onUserLeftSession), and out-of-bounds (killLocalPlayer). Four independently-guarded
    //phases (F0/NET-13): a throw in one phase (e.g. a dead-ref destroy) must never abort the
    //rest of the teardown. visualIDHint (F3/NET-14) is the victim's color index carried in the
    //death payload / resolved pre-slot-zero, so the remote sweep's prefix fallback never
    //depends on a color slot every client is simultaneously zeroing.
    handlePlayerDeath(ID: number, visualIDHint?: number){
        // F2 guard (blocker): clientID 0 is the "unclaimed" sentinel. A 0-ID death would
        // component-match every lazily-subscribed cell (they read vec2.zero()) and wipe the
        // whole session's territory — drop it outright, and never register it recently-dead.
        if (!ID) {
            this.log("NetworkerV2: Ignoring death of clientID 0 — collides with the unclaimed sentinel");
            return;
        }

        this.log("NetworkerV2: Handling death of player " + ID);

        // F2: open the recently-dead window — the cell/slot interceptors clear any write
        // attributed to this player that was SENT before the window closes (their in-flight
        // pending writes, which the Phase 3 sweep below can't see from other devices).
        this.registerRecentlyDead(ID);

        if (ID === this.clientID) {
            // Phase 1 — local-only teardown (this device is the dead player)
            try {
                this.deathPhaseLocalTeardown();
            } catch (e) {
                this.log("NetworkerV2: ERROR in death phase 1 (local teardown): " + e);
            }
        } else {
            // Phase 2 — remote-player visual sweep. Deliberately NOT gated on gridReady
            // (F4/NET-15): the Instantiator can have materialized every volume while the grid
            // entity is still initializing, and owner-key matching (F3) needs neither the grid
            // nor the color slots. Pre-SessionController-ready the instance map is empty (no-op).
            try {
                this.deathPhaseRemoteVisualSweep(ID, visualIDHint);
            } catch (e) {
                this.log("NetworkerV2: ERROR in death phase 2 (remote visual sweep): " + e);
            }
        }

        // Phase 3 — cloud cell sweep (best-effort — only covers cells that have been
        // getCellProperty'd on this device)
        try {
            if (this.gridReady) {
                this.deathPhaseCellSweep(ID);
            }
        } catch (e) {
            this.log("NetworkerV2: ERROR in death phase 3 (cell sweep): " + e);
        }

        // Phase 4 — color-slot free, its own phase so a cell-sweep failure can't skip it.
        // Unconditional (no gridReady guard): the slots array is empty before ready, so no-op.
        try {
            this.deathPhaseFreeColorSlot(ID);
        } catch (e) {
            this.log("NetworkerV2: ERROR in death phase 4 (color-slot free): " + e);
        }
    }

    // Phase 1: mark this device as dead and tear down its own tracking state
    private deathPhaseLocalTeardown(): void {
        this.isAlive = false;
        this.firstClaim = true;
        this.stakeList = [];
        // NET-3: invalidate any in-flight conversion/interior chain and pending delayed stake
        // write scheduled by this (now-dead) life, and clear the mutex so it can't linger while
        // dead (respawn() also clears it, but clearing here keeps it consistent on death alone).
        this.conversionEpoch++;
        // F1/NET-11: invalidate this life's in-flight CLAIM spawns too (stake spawns are covered
        // by the conversionEpoch bump above) — their onSuccess destroys them at the source.
        this.deathEpoch++;
        this.isPerformingBulkConversion = false;
        this.localCellState.clear();
        this.localCacheTimestamps.clear();
        // spawnedClaims/spawnedStakes track only locally-spawned objects, so these are the right teardown paths
        this.PlayerVisuals.DestroyAllStakes();
        this.PlayerVisuals.DestroyAllClaims();
    }

    // Phase 2: destroy a remote player's visual objects on this device via Instantiator lookup
    private deathPhaseRemoteVisualSweep(ID: number, visualIDHint?: number): void {
        this.PlayerVisuals.destroyPlayerVisuals(ID, this.getPlayerVisualID.bind(this), visualIDHint);
    }

    // Phase 3: zero the dead player's own claim/stake components in every subscribed cell.
    // F2/NET-12: matches currentValue OR currentOrPendingValue — the victim's freshest writes
    // went through setPendingValue, which only cop sees until the flush/echo; matching cur alone
    // let those writes flush to the cloud AFTER death and go permanently stale. Component
    // matches require a nonzero component (never match the "unclaimed" sentinel). The clear is
    // BASED on cop whenever cop names the dead player — cop is always at least as fresh as
    // currentValue on-device, which also stops a same-frame mutual death from resurrecting the
    // first victim's just-cleared component (its clear is pending, so cur still holds the old
    // value while cop already has the zero).
    private deathPhaseCellSweep(ID: number): void {
        for (const [key, cellProp] of this.gridCells) {
            // try/catch INSIDE the loop: one bad cell must not abandon the rest of the sweep
            try {
                const cur = cellProp.currentValue || vec2.zero();
                const cop = cellProp.currentOrPendingValue || vec2.zero();
                const copNamesID = (cop.x !== 0 && cop.x === ID) || (cop.y !== 0 && cop.y === ID);
                const claimClear = (cur.x !== 0 && cur.x === ID) || (cop.x !== 0 && cop.x === ID);
                const stakeClear = (cur.y !== 0 && cur.y === ID) || (cop.y !== 0 && cop.y === ID);
                if (!claimClear && !stakeClear) continue;
                // NET-18: trust cop whenever it has ANY nonzero component — such a value was
                // necessarily set post-subscription (setPendingValue or applyRemoteValue both set
                // currentOrPendingValue), so it is at least as fresh as cur on-device. This keeps
                // our own un-flushed pending write (e.g. a respawn home claim over a stale cur
                // naming the dead player) from being dropped in the sub-frame window before the
                // LateUpdate promotion. An ALL-ZERO cop may just be the silentSetCurrentValue
                // seeding gotcha (never set post-subscription) and MUST fall back to cur.
                const base = (copNamesID || cop.x !== 0 || cop.y !== 0) ? cop : cur;
                const newValue = new vec2(claimClear ? 0 : base.x, stakeClear ? 0 : base.y);
                const keyParts = key.split('_');
                if (keyParts.length === 3) {
                    const cellX = parseInt(keyParts[1]);
                    const cellY = parseInt(keyParts[2]);
                    this.updateCellValue(cellX, cellY, newValue, "DEATH CLEAR");
                }
            } catch (e) {
                this.log("NetworkerV2: death cell sweep failed for " + key + ": " + e);
            }
        }
    }

    // Phase 4: free the dead player's color slot so a new player can claim it
    private deathPhaseFreeColorSlot(ID: number): void {
        for (let i = 0; i < this.playerColorSlots.length; i++) {
            const val = this.playerColorSlots[i].currentValue;
            if (val && val.x === ID) {
                this.playerColorSlots[i].setPendingValue(vec2.zero());
                this.log("NetworkerV2: Freed color slot " + i + " for player " + ID);
                break;
            }
        }
    }

    // F4/NET-15: bounded replay of deaths that arrived before gridReady. The staleness bounds
    // are what keep a replay from destroying a respawned/rejoined player's NEW life (clientIDs
    // are stable across lives):
    //  - never replay our own death — the identity check must not be re-evaluated now that
    //    clientID has been assigned (a stale self-entry would kill the just-joined local player);
    //  - kill entries expire after RECENTLY_DEAD_TTL_MS — the victim stays connected and its own
    //    epoch-gated onSuccess self-cleans, so a stale replay is pure friendly-fire risk;
    //  - leave entries replay at any age but are skipped if the player has since rejoined.
    // The replay runs the visual sweep + slot-free (+ departed tracking) — explicitly NOT the
    // Phase 3 cell sweep: gridCells is empty at this instant, so it would be a silent no-op.
    // Leave entries DO run the full-store sweep (NET-5): unlike Phase 3 it needs only
    // currentStore (ready now), not gridCells — this is what heals a pre-ready leaver's cells
    // for this client; the getCellProperty seed-check remains the second-line defense.
    private replayPendingDeathCleanups(): void {
        const pending = this.pendingDeathCleanups;
        this.pendingDeathCleanups = [];
        for (const entry of pending) {
            if (entry.id === this.clientID) continue;
            if (!entry.isLeave && (Date.now() - entry.queuedAt) > this.RECENTLY_DEAD_TTL_MS) {
                this.log("NetworkerV2: dropping stale queued kill cleanup for " + entry.id);
                continue;
            }
            if (entry.isLeave && this.isClientPresent(entry.id)) {
                this.log("NetworkerV2: skipping queued leave cleanup for " + entry.id + " — rejoined");
                continue;
            }
            this.log("NetworkerV2: replaying queued death cleanup for " + entry.id + (entry.isLeave ? " (leave)" : " (kill)"));
            try {
                this.deathPhaseRemoteVisualSweep(entry.id, entry.hint);
            } catch (e) {
                this.log("NetworkerV2: ERROR in replayed visual sweep for " + entry.id + ": " + e);
            }
            try {
                this.deathPhaseFreeColorSlot(entry.id);
            } catch (e) {
                this.log("NetworkerV2: ERROR in replayed slot free for " + entry.id + ": " + e);
            }
            if (entry.isLeave) {
                this.departedClients.add(entry.id);
                // NET-5: the store sweep needs currentStore (ready now), NOT gridCells —
                // unlike Phase 3, it works at replay time even though no cells are subscribed.
                try {
                    this.sweepStoreForDepartedClient(entry.id);
                } catch (e) {
                    this.log("NetworkerV2: ERROR in replayed store sweep for " + entry.id + ": " + e);
                }
                // Re-anchor the +2s/+8s re-sweeps from ready-time: the pair scheduled at
                // leave-event time can both have fired before gridReady on a slow init, and
                // their store sweeps would have guarded out. Idempotent: present-guard +
                // owner-key-only visuals + read-gated store writes.
                this.scheduleLeaveResweeps(entry.id, entry.hint);
            }
        }
    }

    // F1/NET-11: a volume whose createRealtimeStore round-trip spanned the leave cleanup is in
    // neither the victim's arrays nor anyone's spawnedInstances yet — it materializes on every
    // client AFTER the sweeps ran, and the leaver's device is gone so no epoch-gated onSuccess
    // can self-clean it. Re-sweep at +2s/+8s, owner-key ONLY (a prefix match could hit a
    // rejoined player's new visuals), and skip entirely if the player is present again.
    // NET-5: no longer visual-only — each firing also re-runs the full-store cell sweep,
    // catching the leaver's in-flight cell writes that landed in our replica after the
    // immediate sweep's collect pass (the unsubscribed-key equivalent of what the onAnyChange
    // ghost interceptor does for subscribed keys).
    // Leave-only by design: kill victims stay connected and self-clean; a kill re-sweep could
    // destroy the respawned life.
    private scheduleLeaveResweeps(leftClientID: number, hint: number | undefined): void {
        for (const delaySeconds of this.LEAVE_RESWEEP_DELAYS_S) {
            const resweep = this.createEvent("DelayedCallbackEvent");
            resweep.bind(() => {
                if (!this.isClientPresent(leftClientID)) {
                    try {
                        this.PlayerVisuals.destroyPlayerVisuals(leftClientID, this.getPlayerVisualID.bind(this), hint, true);
                    } catch (e) {
                        this.log("NetworkerV2: ERROR in leave re-sweep for " + leftClientID + ": " + e);
                    }
                    // NET-5: store re-sweep (guarded internally on gridReady/departed/presence)
                    try {
                        this.sweepStoreForDepartedClient(leftClientID);
                    } catch (e) {
                        this.log("NetworkerV2: ERROR in leave store re-sweep for " + leftClientID + ": " + e);
                    }
                }
                this.removeEvent(resweep); // one-shot: drop it so events don't accumulate unbounded
            });
            resweep.reset(delaySeconds);
        }
    }

    // NET-5 (leave residual): full-store sweep for a DEPARTED client — enumerates
    // currentStore.getAllKeys() and per-component-clears every UNSUBSCRIBED cell_ key naming
    // the leaver, so leaving is fully equivalent to dying even in regions no remaining client
    // has subscribed (and late joiners, who never receive the leave event, inherit a clean
    // store). Three hard rules:
    //  1. Subscribed keys (gridCells) are SKIPPED: SyncEntity skips self-echoes, so a raw
    //     putVec2 on a key we hold a StorageProperty for would leave our OWN property stale —
    //     those cells belong to Phase 3 + the onAnyChange ghost interceptor.
    //  2. Clears are putVec2 writes, never store.remove(): SyncEntity never wires
    //     onStoreKeyRemoved, so a remove would not propagate to other clients' subscribed
    //     properties.
    //  3. LEAVE-ONLY BY DESIGN — never call for kills: clientIDs are stable across lives, so a
    //     late full-store sweep after a kill would erase the respawned victim's new claims.
    //     The departedClients guard makes this structural (kills never enter that set).
    // NET-6-class redundancy (accepted, documented): every remaining client runs this, but
    // reads are local, writes are read-gated + changed-only, and chunk pacing staggers
    // duplicates — later clients see zeros and skip; duplicates only inside the RTT window.
    private sweepStoreForDepartedClient(leftClientID: number): void {
        // NET-2: clientID 0 is the "unclaimed" sentinel — a 0-sweep must never run.
        if (!leftClientID) return;
        // Pre-ready leaves are replayed by replayPendingDeathCleanups once the store exists.
        if (!this.gridReady) return;
        const store = this.gridSyncEntity.currentStore;
        if (!store || !this.gridSyncEntity.canIModifyStore()) return;
        if (!this.departedClients.has(leftClientID)) return; // rejoined (or never left)
        if (this.isClientPresent(leftClientID)) return;      // rejoin protection, per invocation

        // Collect pass — local reads only, no network cost, so no chunking needed here.
        const matched: string[] = [];
        try {
            const allKeys = store.getAllKeys();
            for (const key of allKeys) {
                // try/catch INSIDE the loop: one bad key must not abandon the sweep
                try {
                    if (key.indexOf("cell_") !== 0) continue; // never touch slot/SDK keys
                    if (this.gridCells.has(key)) continue;    // property path owns subscribed keys
                    const keyParts = key.split('_');
                    if (keyParts.length !== 3) continue;
                    const cellX = parseInt(keyParts[1]);
                    const cellY = parseInt(keyParts[2]);
                    if (isNaN(cellX) || isNaN(cellY) || !this.isInBounds(cellX, cellY)) continue;
                    const val = store.getVec2(key);
                    if (!val || isNaN(val.x) || isNaN(val.y)) continue;
                    if (val.x !== leftClientID && val.y !== leftClientID) continue;
                    matched.push(key);
                } catch (e) {
                    this.log("NetworkerV2: STORE SWEEP read failed for " + key + ": " + e);
                }
            }
        } catch (e) {
            this.log("NetworkerV2: STORE SWEEP enumeration failed: " + e);
            return;
        }
        if (matched.length === 0) return;
        this.log("NetworkerV2: STORE SWEEP - " + matched.length + " unsubscribed cell(s) still name departed player " + leftClientID);
        this.healStoreCellsChunked(leftClientID, matched, 0);
    }

    // Paced heal pass for sweepStoreForDepartedClient. Every write RE-VALIDATES against the
    // live store — the value can change between the collect pass and a later chunk. Most
    // dangerously: the leaver rejoins mid-chain (same clientID) and claims a collected cell —
    // blind-writing the stale heal would erase their new life's territory, so a rejoin aborts
    // the whole chain and each key is re-read before writing.
    private healStoreCellsChunked(leftClientID: number, keys: string[], startIndex: number): void {
        if (this.isClientPresent(leftClientID) || !this.departedClients.has(leftClientID)) return;
        const store = this.gridSyncEntity.currentStore;
        if (!store || !this.gridSyncEntity.canIModifyStore()) return;
        const end = Math.min(startIndex + this.STORE_SWEEP_CHUNK, keys.length);
        for (let i = startIndex; i < end; i++) {
            const key = keys[i];
            try {
                if (this.gridCells.has(key)) continue; // subscribed since collect — property path owns it now
                const val = store.getVec2(key);
                if (!val) continue;
                const clearClaim = val.x !== 0 && val.x === leftClientID;
                const clearStake = val.y !== 0 && val.y === leftClientID;
                if (!clearClaim && !clearStake) continue; // changed since collect (e.g. another client's heal landed)
                store.putVec2(key, new vec2(clearClaim ? 0 : val.x, clearStake ? 0 : val.y));
            } catch (e) {
                this.log("NetworkerV2: STORE SWEEP heal failed for " + key + ": " + e);
            }
        }
        if (end < keys.length) {
            const chunkEvent = this.createEvent("DelayedCallbackEvent");
            chunkEvent.bind(() => {
                this.healStoreCellsChunked(leftClientID, keys, end);
                this.removeEvent(chunkEvent); // one-shot, matching the resweep/conversion pattern
            });
            chunkEvent.reset(this.STORE_SWEEP_CHUNK_DELAY_S);
        }
    }

    // True when a client with this ID is currently connected to the session. Presence ≠ alive —
    // a dead-but-connected (respawning) player IS present, which is exactly right for every
    // caller (F5 kill gate, ghost predicate, leave re-sweeps, replay policy).
    // NET-17/TD-11: Set-backed — the cache answers without hashing, and a cached player can't
    // transiently read as absent just because getUsers() momentarily reports a blank displayName.
    // The fallback scan covers ids the cache never saw, backfilling every hash it computes.
    // No negative caching: an absent id must stay re-checkable (it may join later).
    isClientPresent(id: number): boolean {
        if (!id) return false;
        if (this.clientID && id === this.clientID) return true; // the local player is always present
        if (this.presentClientIDs.has(id)) return true;
        let found = false;
        const users = SessionController.getInstance().getUsers();
        for (const user of users) {
            if (user && user.displayName) {
                const uid = this.computeClientID(user.displayName);
                if (uid) {
                    this.presentClientIDs.add(uid);
                    if (uid === id) found = true;
                }
            }
        }
        return found;
    }

    // NET-17/TD-11: seed/backfill the presence cache from the live user list. Users with a
    // (transiently) blank displayName can't be hashed here — they're added when their join
    // event fires or a later scan sees a valid name.
    private seedPresentClients(): void {
        const users = SessionController.getInstance().getUsers();
        for (const user of users) {
            if (user && user.displayName) {
                const uid = this.computeClientID(user.displayName);
                if (uid) this.presentClientIDs.add(uid);
            }
        }
    }

    // Current server time in ms, or null when the session clock is unavailable (no session yet
    // / not connected — the SDK returns null or a negative timestamp in those cases).
    private nowServerMs(): number | null {
        const seconds = SessionController.getInstance().getServerTimeInSeconds();
        return (seconds === null || seconds === undefined || seconds <= 0) ? null : seconds * 1000;
    }

    // F2: open the ghost window for a player who just died/left (see recentlyDead field docs).
    private registerRecentlyDead(ID: number): void {
        const serverNow = this.nowServerMs();
        this.recentlyDead.set(ID, {
            serverDeadline: serverNow !== null ? serverNow + this.RECENTLY_DEAD_TTL_MS : null,
            localDeadline: Date.now() + this.RECENTLY_DEAD_TTL_MS,
        });
    }

    // F2: true when a write attributed to `id` was SENT inside their post-death ghost window.
    // sentServerMs is the write's server-side send time (remote updates); null means a local
    // echo or a seeded value, for which the current time is the best available bound.
    private isRecentlyDead(id: number, sentServerMs: number | null): boolean {
        const entry = this.recentlyDead.get(id);
        if (!entry) return false;
        if (entry.serverDeadline !== null) {
            const t = (sentServerMs !== null && sentServerMs > 0) ? sentServerMs : this.nowServerMs();
            if (t !== null) return t <= entry.serverDeadline;
            // server clock unavailable for the comparison — fall back to the local deadline
        }
        return Date.now() <= entry.localDeadline;
    }

    // F2: a "ghost author" is a departed client (no window — leaves are permanent) or a
    // recently-dead one whose write predates their window's close.
    // NET-16/TD-13: a PRESENT client is never a ghost — the one predicate for both the cell and
    // slot interceptors. The presence check protects a fast-rejoiner's fresh writes and a kill
    // victim's post-respawn slot re-claim; absent authors (the ones who can't self-clean) are
    // still cleared. A present-but-dead kill victim needs no interception: their own device's
    // Phase 3 sweep rewrites every cell they touched (all subscribed there), and those clears
    // are sent after the stale writes, so last-wins storage converges without it.
    private isGhostID(id: number, sentServerMs: number | null): boolean {
        if (!this.departedClients.has(id) && !this.isRecentlyDead(id, sentServerMs)) return false;
        return !this.isClientPresent(id);
    }

    // F2/NET-12: per-component clear of a cell value naming a ghost author. Called from every
    // cell's onAnyChange (remote arrivals + local echoes) and from the getCellProperty seed-check
    // (values already in the store fire no events). Accepted NET-6-class cost: every client that
    // sees the write issues the same clear — the SDK's equalsCheck suppresses identity writes and
    // the recently-dead window is bounded. Per-component clears on last-wins storage can briefly
    // resurrect a stale other-component (pre-existing pattern, same as DEATH CLEAR).
    private interceptGhostCellWrite(x: number, y: number, val: vec2, updateInfo: ConnectedLensModule.RealtimeStoreUpdateInfo | null): void {
        if (!val) return;
        const sentMs = (updateInfo && updateInfo.sentServerTimeMilliseconds) ? updateInfo.sentServerTimeMilliseconds : null;
        const clearClaim = val.x !== 0 && this.isGhostID(val.x, sentMs);
        const clearStake = val.y !== 0 && this.isGhostID(val.y, sentMs);
        if (!clearClaim && !clearStake) return;
        const healed = new vec2(clearClaim ? 0 : val.x, clearStake ? 0 : val.y);
        this.log("NetworkerV2: GHOST CLEAR - cell (" + x + ", " + y + ") named dead/departed player (claimed=" + val.x + ", staked=" + val.y + ")");
        this.updateCellValue(x, y, healed, "GHOST CLEAR");
    }

    // F2: slot flavor of the ghost interceptor — closes the "slot claimed by a player who left
    // within RTT" color leak (their claim write outraces everyone's slot-free). isGhostID's
    // presence check (TD-13: shared predicate, no open-coded variant) protects a kill victim's
    // post-respawn re-claim (they're connected, so never zeroed here regardless of timing).
    private interceptGhostSlotWrite(slot: StorageProperty<vec2>, val: vec2, updateInfo: ConnectedLensModule.RealtimeStoreUpdateInfo | null): void {
        if (!val || val.x === 0) return;
        if (this.clientID && val.x === this.clientID) return; // our own slot claim is never a ghost
        const sentMs = (updateInfo && updateInfo.sentServerTimeMilliseconds) ? updateInfo.sentServerTimeMilliseconds : null;
        if (this.isGhostID(val.x, sentMs)) {
            this.log("NetworkerV2: GHOST SLOT CLEAR - slot claimed by dead/departed player " + val.x);
            slot.setPendingValue(vec2.zero());
        }
    }

    // F1/NET-11: validity closures captured at spawn-request time and re-checked in the
    // Instantiator's async onSuccess — if the life/batch that requested the spawn has ended,
    // the volume is destroyed at the source instead of tracked (the store deletion propagates
    // to every client). Claims are invalidated only by DEATH (deathEpoch); stakes by death OR
    // conversion-start (conversionEpoch — its two bump sites correspond 1:1 with the two
    // DestroyAllStakes sites).
    private claimSpawnValidity(): () => boolean {
        const epoch = this.deathEpoch;
        return () => this.deathEpoch === epoch;
    }
    private stakeSpawnValidity(): () => boolean {
        const epoch = this.conversionEpoch;
        return () => this.conversionEpoch === epoch;
    }

    // Re-enable a dead local player. Called by LocationTracker when the respawn
    // countdown completes. handlePlayerDeath already reset firstClaim/stakeList/caches
    // and destroyed our visuals, so we only need to flip alive back on, clear the
    // bulk-conversion mutex (in case we died mid-conversion), and re-establish our
    // cloud color slot (handlePlayerDeath freed it on all clients).
    respawn(): void {
        if (!this.gridReady) return;
        this.isAlive = true;
        this.firstClaim = true;              // re-arm home-claim creation
        this.stakeList = [];
        this.isPerformingBulkConversion = false;
        this.assignAndWritePlayerID();       // re-claim a color slot + set this.playerID
        this.log("NetworkerV2: Player " + this.clientID + " respawned");
    }

    // True when (x, y) is a valid grid cell [0, height). Same predicate used by getMiniMapCells.
    isInBounds(x: number, y: number): boolean {
        return x >= 0 && x < this.height && y >= 0 && y < this.height;
    }

    // NET-10/NET-8: true when a (re)spawning player may place their home claim at (x, y) —
    // in-bounds and fully open (no claim, no stake, by anyone). The ONE spawn-legality rule,
    // shared by sendData's firstClaim gate (write-time check for both the initial join and the
    // respawn claim) and LocationTracker.handleRespawnCountdown's per-tick blocked check, so
    // join and respawn can never disagree. Side-effect-free read (no subscription).
    isLegalSpawnCell(x: number, y: number): boolean {
        if (!this.isInBounds(x, y)) return false;
        const cell = this.getCellDataReadOnly(x, y);
        return cell.x === 0 && cell.y === 0;
    }

    // Kill the LOCAL player (e.g. they walked out of the arena). Robust regardless of
    // whether sendEvent echoes to the local sender.
    killLocalPlayer(): void {
        if (!this.gridReady || !this.isAlive) return;
        // F2: clientID 0 collides with the "unclaimed" sentinel — never emit a death for it
        // (remote handlers would drop it anyway; see the handlePlayerDeath guard).
        if (!this.clientID) return;
        // Tell every other client to destroy our visuals, clear our cells, and free our color slot.
        // onlySendRemote=true so the event does NOT loop back and double-run handlePlayerDeath locally.
        // F3: vec3 payload carries our visualID for the remote sweeps' prefix fallback (NET-14).
        this.gridSyncEntity.sendEvent(this.deathEventString, new vec3(this.clientID, this.clientID, this.playerID || 0), true);
        // Run our own teardown now (mirrors the onUserLeftSession path, which calls this directly).
        this.handlePlayerDeath(this.clientID);
        this.log("NetworkerV2: Player " + this.clientID + " died (left play area)");
    }

    //function for returning to claimed region and adding staked region to claim
    addStakedRegionToClaim(realWorldCoords: vec3){
        // Prevent multiple bulk conversions from happening simultaneously
        if (this.isPerformingBulkConversion) {
            this.log("NetworkerV2: Bulk conversion already in progress, skipping");
            return;
        }
        
        //if no stakes exist, return early
        const numOfStakes = this.stakeList.length;
        if (numOfStakes == 0){
            return;
        }
        
        this.isPerformingBulkConversion = true; // Set flag to prevent re-entry
        // NET-3/D3: mark a new batch. Bumping here cancels any still-pending delayed stake write
        // (D3) — every staked cell is in stakeList and thus in this conversion, so those writes
        // must not fire — and stamps this chain so a later death aborts it.
        this.conversionEpoch++;
        const epoch = this.conversionEpoch;
        this.log("NetworkerV2: BULK CONVERSION START - Converting " + numOfStakes + " stakes to claims with proper cloud storage");

        // Destroy stake visuals immediately
        this.PlayerVisuals.DestroyAllStakes();

        // Create copy of stakeList for processing
        const stakesToConvert = [...this.stakeList];

        // Clear the stake list early to prevent new stakes during conversion
        this.stakeList = [];
        this.log("NetworkerV2: stakeList cleared, length now: " + this.stakeList.length);

        // Start sequential conversion with proper cloud storage callbacks
        this.convertStakesSequentially(stakesToConvert, 0, realWorldCoords, epoch, () => {
            this.log("NetworkerV2: ✅ ALL STAKES SUCCESSFULLY CONVERTED TO CLOUD STORAGE!");

            // Find and fill enclosed region after successful conversion
            this.findAndFillEnclosedRegion(stakesToConvert, realWorldCoords, epoch);

            // Reset the conversion flag
            this.isPerformingBulkConversion = false;
            this.log("NetworkerV2: 🔄 Bulk conversion flag RESET - Normal operations resumed");
        });
    }
    
    // New method: Sequential stake conversion with proper cloud storage callbacks
    private convertStakesSequentially(stakes: vec2[], index: number, realWorldCoords: vec3, epoch: number, onComplete: () => void) {
        // NET-3: abort a stale chain (player died, or a newer batch superseded this one). Return
        // WITHOUT calling onComplete so a dead/superseded life never fills the interior.
        if (this.conversionEpoch !== epoch) {
            this.log("NetworkerV2: stake conversion chain aborted (epoch changed) at index " + index);
            return;
        }
        if (index >= stakes.length) {
            this.log("NetworkerV2: Sequential conversion completed for all " + stakes.length + " stakes");
            onComplete();
            return;
        }

        const stake = stakes[index];
        this.log("NetworkerV2: [" + (index + 1) + "/" + stakes.length + "] Converting stake at (" + stake.x + ", " + stake.y + ")");

        const cellProp = this.getCellProperty(stake.x, stake.y);
        if (!cellProp) {
            this.log("NetworkerV2: ERROR - Could not get cell property for stake conversion");
            // Continue with next stake
            this.convertStakesSequentially(stakes, index + 1, realWorldCoords, epoch, onComplete);
            return;
        }
        
        const cellKey = this.getCellKey(stake.x, stake.y);
        const currentValue = this.localCellState.get(cellKey) || cellProp.currentValue || vec2.zero();
        this.log("  BEFORE: claimed=" + currentValue.x + ", staked=" + currentValue.y);
        
        // Verify this cell is actually staked by us
        if (currentValue.y !== this.clientID) {
            this.log("  WARNING: Cell not staked by us! Staked by: " + currentValue.y + ", our ID: " + this.clientID);
        }
        
        // Convert stake to claim (set x to clientID, y to 0)
        const newValue = new vec2(this.clientID, 0);
        
        // Use helper method to ensure both local state and cloud storage are updated
        const success = this.updateCellValue(stake.x, stake.y, newValue, "STAKE→CLAIM CONVERSION");
        
        if (success) {
            this.log("  ✅ CONVERSION SUCCESS: Stake (" + stake.x + ", " + stake.y + ") → Claim");
            this.log("  AFTER: claimed=" + newValue.x + ", staked=" + newValue.y);
            
            //Create visual for newly claimed cell (exterior loop cell)
            const cellCenterCoords = this.gridPosToWorldCoords(stake.x, stake.y);
            //this.log("test first claim by id: " + this.playerID);
            this.PlayerVisuals.createWorldClaimVolume(this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell, this.clientID, this.claimSpawnValidity());
            
            // Add small delay to allow SpectaclesSyncKit to sync to cloud
            const delayedEvent = this.createEvent("DelayedCallbackEvent");
            delayedEvent.bind(() => {
                // Continue to next stake after delay (creates the next event before we drop this one)
                this.convertStakesSequentially(stakes, index + 1, realWorldCoords, epoch, onComplete);
                this.removeEvent(delayedEvent); // one-shot: bound live events to ~1 per active chain
            });
            delayedEvent.reset(0.04); // 40ms delay per conversion
        } else {
            this.log("  ❌ CONVERSION FAILED: Could not convert stake (" + stake.x + ", " + stake.y + ")");
            // Continue to next stake even on failure
            this.convertStakesSequentially(stakes, index + 1, realWorldCoords, epoch, onComplete);
        }
    }
    
    // Main function for filling the loop of cells.
    //
    // NET-4: enclosure on a discrete grid is a CONNECTIVITY problem, not a ray-cast/crossing-parity
    // one (the old point-in-polygon `isInLoop` treated cells as idealized points and missed squares
    // beside diagonal edges). Instead: build a barrier of cells the fill can't cross, flood the
    // EXTERIOR with a 4-connected BFS seeded outside the loop, and claim every in-bbox cell the flood
    // can't reach. This is the standard "flood the ocean, capture what it can't reach" technique.
    findAndFillEnclosedRegion(loop: vec2[], realWorldCoords: vec3, epoch: number) {
        // A loop needs at least a few cells to enclose anything.
        if (loop.length < 4) {
            return;
        }

        // Bounding box of the stake trail.
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const cell of loop) {
            minX = Math.min(minX, cell.x);
            maxX = Math.max(maxX, cell.x);
            minZ = Math.min(minZ, cell.y);
            maxZ = Math.max(maxZ, cell.y);
        }

        // A bbox that is a single cell wide/tall can't enclose anything.
        if (maxX - minX <= 1 || maxZ - minZ <= 1) {
            this.log("NetworkerV2: findAndFillEnclosedRegion: stake bounding box has no interior, returning early.");
            return;
        }

        // Cells are in [0, height); (x, z) -> unique integer key (no per-cell string allocation).
        const key = (x: number, z: number) => x * this.height + z;

        const barrier = new Set<number>();
        const addBarrier = (x: number, z: number) => {
            if (this.isInBounds(x, z)) {
                barrier.add(key(x, z));
            }
        };

        // (a) The trail itself, DENSIFIED with an integer (Bresenham) line between consecutive cells,
        // so a fast/diagonal step that crosses >1 cell in a single 0.1s tick can't leave a hole the
        // exterior flood leaks through. Added UNCONDITIONALLY (never gated on a cell read) so the seal
        // always holds. No last->first edge — the loop closes through owned territory (added in (b)).
        for (let i = 0; i < loop.length; i++) {
            addBarrier(loop[i].x, loop[i].y);
            if (i + 1 < loop.length) {
                const seg = this.bresenhamLine(loop[i], loop[i + 1]);
                for (const c of seg) {
                    addBarrier(c.x, c.y);
                }
            }
        }

        // (b) My existing claimed cells within the bbox. These seal the gap between the trail's first
        // and last cells through real territory (Paper.io: boundary = existing territory + new trail).
        // Enemy-owned cells (.x !== clientID) are intentionally NOT barriers, so an enemy cell trapped
        // inside the loop is unreachable by the flood -> captured and overwritten to me.
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                if (this.isInBounds(x, z) && this.getCellDataReadOnly(x, z).x === this.clientID) {
                    barrier.add(key(x, z));
                }
            }
        }

        // (c) 4-connected exterior flood over the bbox expanded by one cell (a guaranteed-outside
        // ring). 4-connectivity is REQUIRED so a diagonal (8-connected) barrier seals: the flood can't
        // slip through the corner-touch between two diagonally adjacent barrier cells. Out-of-grid
        // neighbors count as exterior, so loops hugging the arena edge fill correctly (the arena edge
        // is open, not a wall — consistent with out-of-bounds = death).
        const loX = minX - 1, hiX = maxX + 1;
        const loZ = minZ - 1, hiZ = maxZ + 1;
        const inRegion = (x: number, z: number) => x >= loX && x <= hiX && z >= loZ && z <= hiZ;

        const exterior = new Set<number>();
        const queue: vec2[] = [];
        const seed = (x: number, z: number) => {
            if (!inRegion(x, z) || !this.isInBounds(x, z)) return;
            const k = key(x, z);
            if (barrier.has(k) || exterior.has(k)) return;
            exterior.add(k);
            queue.push(new vec2(x, z));
        };

        // Seed every in-bounds, non-barrier cell that touches the region border or the grid edge
        // (i.e. has an out-of-region or out-of-grid 4-neighbor) — those are guaranteed exterior.
        for (let x = loX; x <= hiX; x++) {
            for (let z = loZ; z <= hiZ; z++) {
                if (!this.isInBounds(x, z)) continue;
                const onRegionBorder = x === loX || x === hiX || z === loZ || z === hiZ;
                const touchesGridEdge = !this.isInBounds(x + 1, z) || !this.isInBounds(x - 1, z)
                                     || !this.isInBounds(x, z + 1) || !this.isInBounds(x, z - 1);
                if (onRegionBorder || touchesGridEdge) {
                    seed(x, z);
                }
            }
        }

        // BFS: 4-connected, staying within the region, never crossing a barrier.
        let head = 0;
        while (head < queue.length) {
            const cur = queue[head++];
            seed(cur.x + 1, cur.y);
            seed(cur.x - 1, cur.y);
            seed(cur.x, cur.y + 1);
            seed(cur.x, cur.y - 1);
        }

        // (d) Interior = in-bounds bbox cells that are neither barrier nor exterior. Iterate the FULL
        // bbox: in concave loops a non-trail cell on the bbox border can be interior, and the flood
        // has already marked it exterior if it was actually reachable from outside.
        const interiorCells: vec2[] = [];
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                if (!this.isInBounds(x, z)) continue;
                const k = key(x, z);
                if (!barrier.has(k) && !exterior.has(k)) {
                    interiorCells.push(new vec2(x, z));
                }
            }
        }

        if (interiorCells.length === 0) {
            this.log("NetworkerV2: No interior cells found to claim");
            return;
        }

        this.log("NetworkerV2: Found " + interiorCells.length + " interior cells to claim with cloud storage");

        // Convert interior cells using cloud storage (unchanged async chain + epoch abort guard).
        this.claimInteriorCellsSequentially(interiorCells, 0, realWorldCoords, epoch, () => {
            this.log("NetworkerV2: ✅ All interior cells successfully claimed in cloud storage!");
            this.log("NetworkerV2: Flood-fill region fill complete!");
        });
    }
    
    // New method: Sequential interior cell claiming with proper cloud storage callbacks
    private claimInteriorCellsSequentially(cells: vec2[], index: number, realWorldCoords: vec3, epoch: number, onComplete: () => void) {
        // NET-3: abort a stale chain (player died, or a newer batch superseded this one).
        if (this.conversionEpoch !== epoch) {
            this.log("NetworkerV2: interior claim chain aborted (epoch changed) at index " + index);
            return;
        }
        if (index >= cells.length) {
            this.log("NetworkerV2: Sequential interior claiming completed for all " + cells.length + " cells");
            onComplete();
            return;
        }

        const cell = cells[index];
        this.log("NetworkerV2: [" + (index + 1) + "/" + cells.length + "] Claiming interior cell at (" + cell.x + ", " + cell.y + ")");

        const cellProp = this.getCellProperty(cell.x, cell.y);
        if (!cellProp) {
            this.log("NetworkerV2: ERROR - Could not get cell property for interior cell");
            // Continue with next cell
            this.claimInteriorCellsSequentially(cells, index + 1, realWorldCoords, epoch, onComplete);
            return;
        }
        
        // Claim this interior cell
        const newValue = new vec2(this.clientID, 0);
        
        // Use helper method to ensure both local state and cloud storage are updated
        const success = this.updateCellValue(cell.x, cell.y, newValue, "INTERIOR CLAIM");
        
        if (success) {
            this.log("  ✅ INTERIOR CELL CLAIMED: (" + cell.x + ", " + cell.y + ") updated");
            
            // Create visual for newly claimed cell
            const cellCenterCoords = this.gridPosToWorldCoords(cell.x, cell.y);
            //this.log("test first claim by id: " + this.playerID);
            this.PlayerVisuals.createWorldClaimVolume(this.playerID, cellCenterCoords.x, realWorldCoords.y, cellCenterCoords.y, this.unitsPerCell, this.clientID, this.claimSpawnValidity());
            
            // Add small delay to allow SpectaclesSyncKit to sync to cloud
            const delayedEvent = this.createEvent("DelayedCallbackEvent");
            delayedEvent.bind(() => {
                // Continue to next cell after delay (creates the next event before we drop this one)
                this.claimInteriorCellsSequentially(cells, index + 1, realWorldCoords, epoch, onComplete);
                this.removeEvent(delayedEvent); // one-shot: bound live events to ~1 per active chain
            });
            delayedEvent.reset(0.05); // 50ms delay per claim
        } else {
            this.log("  ❌ INTERIOR CLAIM FAILED: Could not claim cell (" + cell.x + ", " + cell.y + ")");
            // Continue to next cell even on failure
            this.claimInteriorCellsSequentially(cells, index + 1, realWorldCoords, epoch, onComplete);
        }
    }
    
    // Integer (Bresenham) line between two grid cells, both endpoints inclusive. Used to densify the
    // stake trail so a fast/diagonal step that skips cells still forms a connected barrier for the
    // flood fill in findAndFillEnclosedRegion. A no-op (returns just the endpoints) for adjacent cells.
    private bresenhamLine(a: vec2, b: vec2): vec2[] {
        const points: vec2[] = [];
        let x0 = Math.round(a.x), y0 = Math.round(a.y);
        const x1 = Math.round(b.x), y1 = Math.round(b.y);
        const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        while (true) {
            points.push(new vec2(x0, y0));
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x0 += sx; }
            if (e2 < dx) { err += dx; y0 += sy; }
        }
        return points;
    }

    // FNV-1a hash matching LocationTracker.getDeterministicPlayerId —
    // used to recover the clientID of a leaving player from their display name
    private computeClientID(displayName: string): number {
        if (!displayName) return 0;
        let hash = 0x811c9dc5;
        for (let i = 0; i < displayName.length; i++) {
            hash ^= displayName.charCodeAt(i);
            hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        }
        return (hash >>> 0) % 0xFFFFFF;
    }

    //gated logging: only prints when showLogs is enabled
    private log(msg: string): void {
        if (this.showLogs) {
            print(msg);
        }
    }
}