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


  //on awake, start tracking once session controller starts up
  onAwake() {
      //print('' + this.playerTracker.getTransform().getWorldPosition());
      
      //session controller singleton instance
      this.seshController = SessionController.getInstance();
      //TODO: incorporate this if/else in getDeviceTrackerPosition
      //only send location (relative to colocated world space) if seshController is ready

      //TODO: use sessioncontroller's colocated world space as world origin
      this.seshController.notifyOnReady(() => {
        // SessionController is ready to use
        print('session controller notify on ready');
        //start sending position to grid claimer
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

  
    
  //return player device tracking position (world origin is 0, 0, 0)
  getDeviceTrackerPosition() {
    //var position = this.playerTracker.getTransform().getWorldPosition();
    //print("Device Tracker Position: " + position);
    //this.getDeviceTrackerPosition.reset(1.0);
    this.getNewPosition = this.createEvent('DelayedCallbackEvent');
    this.getNewPosition.bind(() => {
        // Session is ready (after singleplayer or multiplayer button click)
        print('session controller done with sleepy time');
        //TODO: ensure there is no need to update below line to use session controller info
        var position = this.playerTracker.getTransform().getWorldPosition();
        this.GridClaimer.updatePos(position.x, position.y, position.z);
        this.getNewPosition.reset(.5); // delay in seconds before repeat call
    });
    
    // Kick it off immediately
    this.getNewPosition.reset(0.0);
  }



}