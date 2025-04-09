import { GridClaimer } from './GridClaimer';

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

  //on awake, start tracking once session controller starts up
  onAwake() {
      //print('' + this.playerTracker.getTransform().getWorldPosition());
      this.getDeviceTrackerPosition();
      //this.initializeLocationTracking();

  }
  
  //returns the rotation of the device in world space (for player arrow visual)   
    // Convert quaternion to Euler and return Z (yaw)
    getDeviceTrackerRotation(): number {
        const rot = this.playerTracker.getTransform().getWorldRotation();
        print('device rot: ' + rot);
        // Convert quaternion to Euler angles and extract yaw (z-axis rotation)
        const siny_cosp = 2 * (rot.w * rot.z + rot.x * rot.y);
        const cosy_cosp = 1 - 2 * (rot.y * rot.y + rot.z * rot.z);
        let yaw = Math.atan2(siny_cosp, cosy_cosp);
    
        // Normalize the yaw to be in range 0 to 2π
        if (yaw < 0) yaw += 2 * Math.PI;
    
        // Now subtract π/2 to make 0 = North, π = South
        yaw -= Math.PI / 2;
    
        // Normalize the yaw to the range 0 to 2π
        if (yaw < 0) yaw += 2 * Math.PI;
        if (yaw >= 2 * Math.PI) yaw -= 2 * Math.PI;
    
        // Return the yaw, now representing 0 = North, π = South, etc.
        return yaw;
    }
    


  
    
  //return player device tracking position (world origin is 0, 0, 0)
  getDeviceTrackerPosition() {
    //var position = this.playerTracker.getTransform().getWorldPosition();
    //print("Device Tracker Position: " + position);
    //this.getDeviceTrackerPosition.reset(1.0);
    this.getNewPosition = this.createEvent('DelayedCallbackEvent');
    this.getNewPosition.bind(() => {
        var position = this.playerTracker.getTransform().getWorldPosition();
        print('X: '+ position.x + ', Z: '+ position.z);
        this.GridClaimer.updatePos(position.x, position.z);
        this.getNewPosition.reset(.5); // delay in seconds
    });
    
    // Kick it off immediately
    this.getNewPosition.reset(0.0);
  }



}