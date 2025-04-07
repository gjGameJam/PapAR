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
        this.getNewPosition.reset(1.0); // delay in seconds
    });
    
    // Kick it off immediately
    this.getNewPosition.reset(0.0);
  }

  initializeLocationTracking() {
    if (this.hasStarted) return;
    this.hasStarted = true;
    this.createAndLogLocationAndHeading();
  }

  createAndLogLocationAndHeading() {
    
    // Create location handler
    this.locationService = GeoLocation.createLocationService();

    // Set the accuracy
    this.locationService.accuracy = GeoLocationAccuracy.Navigation;

    this.repeatUpdateUserLocation = this.createEvent('DelayedCallbackEvent');
    this.repeatUpdateUserLocation.bind(() => {
      // Get users location.
      this.locationService.getCurrentPosition(
        (geoPosition) => {
          if (
            this.timestamp === undefined ||
            this.timestamp.getTime() !== geoPosition.timestamp.getTime()
          ) {
            this.latitude = geoPosition.latitude;
            this.longitude = geoPosition.longitude;
//            this.horizontalAccuracy = geoPosition.horizontalAccuracy;
//            this.verticalAccuracy = geoPosition.verticalAccuracy;
            print('long: ' + this.longitude);
            print('lat: ' + this.latitude);
            this.timestamp = geoPosition.timestamp;
            this.GridClaimer.updatePos(this.latitude, this.longitude);
          }
        },
        (error) => {
          print(error);
        }
      );
      
      // Acquire next location update in 1 second
      this.repeatUpdateUserLocation.reset(1.0);
    });
    
    // Acquire next location immediately with zero delay
    this.repeatUpdateUserLocation.reset(0.0);
  }
}