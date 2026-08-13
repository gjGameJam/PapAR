import { Networker, RESPAWN_FLOOR_S } from './Networker';
import { SessionController } from "SpectaclesSyncKit.lspkg/Core/SessionController";
import {Instantiator} from 'SpectaclesSyncKit.lspkg/Components/Instantiator';
import { PlayerVisuals } from './PlayerVisuals';

@component
export class LocationTracker extends BaseScriptComponent {
    
  unitsPerCell: number = 200;//cells are this number by this number meters
  gridRadius: number = 20;
  
  @input
  playerTracker: DeviceTracking;
    
  @input
  Networker: Networker;
    
  @input
  networkedInstantiator: Instantiator;
    
  //player visuals script for minimap and world objects
  @input
  PlayerVisuals: PlayerVisuals;

  @input
  showLogs: boolean = false; // gate debug prints via this.log()

  private getNewPosition: DelayedCallbackEvent;
  private hasStarted: boolean = false;
  private seshController: SessionController;
  //id number of client to use for material color and unique claim ability
  private clientID: number;

  //respawn countdown state
  private respawnCountdown: number = -1;      // seconds remaining; -1 = inactive
  // TD-14: derived from the shared floor so the RECENTLY_DEAD_TTL_MS < respawn invariant is
  // enforced in one place (Networker.onAwake asserts against RESPAWN_FLOOR_S).
  private readonly respawnDuration: number = RESPAWN_FLOOR_S;
  private readonly respawnTick: number = 0.10; // must match getNewPosition.reset() interval


  //on awake, start tracking once session controller starts up
  onAwake() {
      //session controller singleton instance
      this.seshController = SessionController.getInstance();
      //use sessioncontroller's colocated world space as world origin
      //only send location (relative to colocated world space) if seshController is ready
      this.seshController.notifyOnReady(() => { //session controller (colocated space) is ready
        // SessionController is ready to use
        this.log('session controller notify on ready for location tracker');
        //get snapchat display name (unique)
        var displayName = this.seshController.getLocalUserName();
        //create a unique player id via hashing instead of using string
        this.clientID = this.getDeterministicPlayerId(displayName);
        //Networker has to know which player it is attached to
        this.Networker.setPlayerID(this.clientID);
      });
        
      //wait for networked instantiator to be ready for the device tracker to start
      //sending info because of boundary spawning
      this.networkedInstantiator.notifyOnReady(() => {
        // instantiator is ready to instantiate stuff across the network
        //start sending position to for processing by networker
        //instantiator and session controller are ready now
        this.getDeviceTrackerPosition();
      });
      
  }
    


  
  //returns the rotation of the device in world space (for player arrow visual)   
    // Convert quaternion to Euler and return Z (yaw)
    getDeviceTrackerRotation(): number {
        const rot = this.playerTracker.getTransform().getWorldRotation();
        
        // Calculate yaw from quaternion assuming Y-up (rotation around Y axis)
        const siny_cosp = 2 * (rot.w * rot.y + rot.z * rot.x);
        const cosy_cosp = 1 - 2 * (rot.y * rot.y + rot.x * rot.x);
        let yaw = Math.atan2(siny_cosp, cosy_cosp);
    
        // Normalize yaw to 0 - 2π
        if (yaw < 0) yaw += 2 * Math.PI;

        return yaw
    }

    // Sub-cell offset from the minimap window's center-cell center, in cell units.
    // x: grid +X (screen right), y: grid +Z / row (screen DOWN). Normally in [-0.5, 0.5);
    // briefly exceeds it between a boundary crossing and the next 10 Hz window re-center.
    // Called every frame from PlayerVisuals.onUpdate (like getDeviceTrackerRotation).
    getMiniMapArrowOffset(): vec2 {
        const wp = this.playerTracker.getTransform().getWorldPosition();
        const offset = this.gridRadius + 0.5;
        const gx = wp.x / this.unitsPerCell + offset;   // continuous grid coords (no floor)
        const gz = wp.z / this.unitsPerCell + offset;
        const center = this.Networker.getMiniMapWindowCenter();
        const cx = center ? center.x : Math.floor(gx);  // pre-first-draw fallback: own cell
        const cy = center ? center.y : Math.floor(gz);
        let ox = gx - (cx + 0.5);                       // 0 = center of center cell
        let oy = gz - (cy + 0.5);
        ox = Math.max(-2.5, Math.min(2.5, ox));         // never leave the 5x5 map frame
        oy = Math.max(-2.5, Math.min(2.5, oy));
        return new vec2(ox, oy);
    }

  
    
  //return player device tracking position (world origin is 0, 0, 0)
  getDeviceTrackerPosition() {
    //var position = this.playerTracker.getTransform().getWorldPosition();
    this.getNewPosition = this.createEvent('DelayedCallbackEvent');
    this.getNewPosition.bind(() => {
        // Session is ready (after singleplayer or multiplayer button click)
        var worldPosition = this.playerTracker.getTransform().getWorldPosition();
        //calculate grid position from world pos
        const gridPos = this.worldCoordsToGridPos(new vec2(worldPosition.x, worldPosition.z));
        //update the hud with location data
        this.PlayerVisuals.updateHUDText(gridPos.x, gridPos.y, worldPosition.x, worldPosition.z, 0, 0);

        // Event-driven minimap: only redraw when the player crosses into a new cell (window shifts)
        // or a cell inside the current window changed value (Networker.miniMapDirty). Replaces the
        // previous unconditional 25-cell read + recolor on every 0.1s tick.
        // NOTE: keep this block ABOVE the alive/dead branch below — handleRespawnCountdown reads the
        // current cell via getCellDataReadOnly, which does NOT subscribe; getMiniMapCells guarantees
        // the window (incl. the player's cell) is subscribed whenever the center changes.
        if (this.Networker.shouldRedrawMiniMap(gridPos.x, gridPos.y)) {
            const miniMapCells = this.Networker.getMiniMapCells(gridPos.x, gridPos.y);
            this.PlayerVisuals.updateMiniMapNetworked(
                miniMapCells,
                (id: number) => this.Networker.getPlayerVisualID(id)
            );
        }

        // NET-1: clientID is assigned in SessionController.notifyOnReady(), which is independent
        // of the instantiator readiness that started this loop. If the instantiator became ready
        // first, clientID is still undefined here — running sendData/getData/respawn now would
        // write vec2(NaN, 0) to the cloud and select a null prefab. HUD + minimap above don't need
        // clientID, so they keep updating; only the game-logic branch waits for it.
        if (this.clientID == null) {
            this.getNewPosition.reset(.10);
            return;
        }

        // While dead, run the respawn countdown instead of the normal stake/claim flow.
        if (this.Networker.gridReady && !this.Networker.isAlive){
            this.handleRespawnCountdown(gridPos, worldPosition);
        } else if (this.Networker.gridReady && !this.Networker.isInBounds(gridPos.x, gridPos.y)) {
            // Leaving the arena kills you. killLocalPlayer flips us dead; next tick runs the
            // respawn countdown (which blocks respawn until we're back in-bounds on open ground).
            this.log("left play area at " + gridPos + " — dying");
            this.Networker.killLocalPlayer();
        } else {
            //retrieve the state of the cell that this player is in
            //cell data is vec2 of (claimedBy = cellVec.x and stakedBy = cellVec.y;) because they can be different
            const cellData = this.Networker.getData(this.clientID, gridPos.x, gridPos.y); //also pass in height for visuals spawning
            const claimedBy = cellData.x;
            const stakedBy = cellData.y;

            // Only track cell movement and send data once the grid is ready.
            // isInSameCell has a side effect: it updates prevGridPos on every false return.
            // If called before gridReady, sendData returns early but prevGridPos is already
            // updated — the player never appears to "enter" their starting cell once the
            // grid becomes ready, so the first home claim is never placed unless they move.
            if (this.Networker.gridReady && !this.PlayerVisuals.isInSameCell(gridPos)){
                this.log("cell: " + gridPos + " is claimed by: " + claimedBy + " and staked by: " + stakedBy);
                this.Networker.sendData(this.clientID, gridPos.x, gridPos.y, worldPosition);
            }
        }

        // delay in seconds before repeat call
        this.getNewPosition.reset(.10);
    });
    
    // Kick it off immediately
    this.getNewPosition.reset(0.0);
  }

    // Drives the respawn countdown while the local player is dead. Resets to full
    // duration whenever the player stands on a claimed or staked cell (so they can't
    // respawn in an OP position), and respawns them once the timer runs out on open ground.
    private handleRespawnCountdown(gridPos: vec2, worldPosition: vec3): void {
        // outOfBounds computed separately only for the display message split below.
        const outOfBounds = !this.Networker.isInBounds(gridPos.x, gridPos.y);
        // NET-10/NET-8: the shared spawn-legality rule — open + in-bounds (off-grid cells read
        // as open, so bounds must be part of the rule). The same predicate gates sendData's
        // firstClaim write, so the countdown and the actual claim can never disagree.
        const blocked = !this.Networker.isLegalSpawnCell(gridPos.x, gridPos.y);

        if (this.respawnCountdown < 0 || blocked) {
            this.respawnCountdown = this.respawnDuration;   // start / reset to full 3s
        } else {
            this.respawnCountdown -= this.respawnTick;
        }

        if (this.respawnCountdown <= 0) {
            // Respawn now (current cell is guaranteed open and in-bounds — countdown only reaches 0 there)
            this.respawnCountdown = -1;
            this.PlayerVisuals.hideRespawnCountdown();
            this.Networker.respawn();
            this.PlayerVisuals.isInSameCell(gridPos);        // sync prevGridPos so we don't double-fire
            this.Networker.sendData(this.clientID, gridPos.x, gridPos.y, worldPosition); // firstClaim==true -> home claim here
        } else {
            this.PlayerVisuals.showRespawnCountdown(Math.ceil(this.respawnCountdown), blocked, outOfBounds);
        }
    }

    // Converts world coordinates to grid position (centered at 0,0 = center of center cell)
    worldCoordsToGridPos(wPos: vec2): vec2 {
        //world offset units divided by unit per cell = cell offset
        const cellX = wPos.x / this.unitsPerCell;
        const cellY = wPos.y / this.unitsPerCell;
        //want to be in center of cell so add .5
        //want to be in center of grid so add gridradius
        const offset = this.gridRadius + 0.5;
        //always want grid # to be int so floor offset + cellPos to get grid #
        const col = Math.floor(cellX + offset);
        const row = Math.floor(cellY + offset);
    
        return new vec2(col, row);
    }
    
    //helper function for hashing string (hash unique display name to unique ID)
    getDeterministicPlayerId(displayName: string): number {
        if (displayName == null){
            return 0;
        }
        let hash = 0x811c9dc5;
        for (let i = 0; i < displayName.length; i++) {
            hash ^= displayName.charCodeAt(i);
            hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        }
        
        //ensure number can be stored within 32 bits
        const MAX_SAFE_FLOAT32_INT = 0xFFFFFF; // 16777215
        return (hash >>> 0) % MAX_SAFE_FLOAT32_INT;
    }

    //gated logging: only prints when showLogs is enabled
    private log(msg: string): void {
        if (this.showLogs) {
            print(msg);
        }
    }




}