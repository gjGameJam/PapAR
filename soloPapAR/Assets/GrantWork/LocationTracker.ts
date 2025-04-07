require('LensStudio:RawLocationModule');
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