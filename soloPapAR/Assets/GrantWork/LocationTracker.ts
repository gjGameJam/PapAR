import { GridClaimer } from './GridClaimer';
import {SessionController} from '../SpectaclesSyncKit/Core/SessionController';

@component
export class LocationTracker extends BaseScriptComponent {
  latitude: number;
  longitude: number;
  altitude: number;
  horizontalAccuracy: number;
  verticalAccuracy: number;
  timestamp: Date;
  locationSource: string;
  
  @input
  playerTracker: DeviceTracking;
    
  @input
  GridClaimer: GridClaimer;

  private repeatUpdateUserLocation: DelayedCallbackEvent;
  private getNewPosition: DelayedCallbackEvent;
  private locationService: LocationService;
  private hasStarted: boolean = false;
  private seshController: SessionController;
  //id number of client to use for material color and unique claim ability
  private clientID: number;


  //on awake, start tracking once session controller starts up
  onAwake() {
      //session controller singleton instance
      this.seshController = SessionController.getInstance();
      //TODO: use sessioncontroller's colocated world space as world origin
      //only send location (relative to colocated world space) if seshController is ready
      this.seshController.notifyOnReady(() => { //session controller (colocated space) is ready
        // SessionController is ready to use
        print('session controller notify on ready for location tracker');
        //Networker contains sync entity with grid storage property
        //start sending position to for processing by networker
        this.getDeviceTrackerPosition();
      });
      //get snapchat display name (unique)
      var displayName = this.seshController.getLocalUserName();
      //create a unique player id via hashing instead of using string
      this.clientID = this.getDeterministicPlayerId(displayName);
      
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

  
    
  //return player device tracking position (world origin is 0, 0, 0)
  getDeviceTrackerPosition() {
    //var position = this.playerTracker.getTransform().getWorldPosition();
    this.getNewPosition = this.createEvent('DelayedCallbackEvent');
    this.getNewPosition.bind(() => {
        // Session is ready (after singleplayer or multiplayer button click)
        //TODO: ensure there is no need to update below line to use session controller info
        var position = this.playerTracker.getTransform().getWorldPosition();
        this.GridClaimer.updatePos(position.x, position.y, position.z);
        //TODO: send position and this.clientID to networker for processing
        
        // delay in seconds before repeat call
        this.getNewPosition.reset(.35);
    });
    
    // Kick it off immediately
    this.getNewPosition.reset(0.0);
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
        return hash >>> 0; // Convert to unsigned 32-bit int
    }




}