require('LensStudio:RawLocationModule');

@component
export class LocationExample extends BaseScriptComponent {
  latitude: number;
  longitude: number;
  altitude: number;
  horizontalAccuracy: number;
  verticalAccuracy: number;
  timestamp: Date;
  locationSource: string;

  private repeatUpdateUserLocation: DelayedCallbackEvent;
  private locationService: LocationService;
  onAwake() {
    this.createEvent('OnStartEvent').bind(() => {
      this.createAndLogLocationAndHeading();
    });

    this.repeatUpdateUserLocation = this.createEvent('DelayedCallbackEvent');
    this.repeatUpdateUserLocation.bind(() => {
      // Get users location.
      this.locationService.getCurrentPosition(
        function (geoPosition) {
          print('locationupdate');
          //Check if location coordinates have been updated based on timestamp
          if (
            this.timestamp === undefined ||
            this.timestamp.getTime() != geoPosition.timestamp.getTime()
          ) {
            this.latitude = geoPosition.latitude;
            this.longitude = geoPosition.longitude;
            this.horizontalAccuracy = geoPosition.horizontalAccuracy;
            this.verticalAccuracy = geoPosition.verticalAccuracy;
            print('long: ' + this.longitude);
            print('lat: ' + this.latitude);
            if (geoPosition.altitude != 0) {
              this.altitude = geoPosition.altitude;
              print('altitude: ' + this.altitude);
            }
            this.timestamp = geoPosition.timestamp;
          }
        },
        function (error) {
          print(error);
        }
      );
      // Acquire next location update in 1 second, increase this value if required for AR visualisation purposes such as 0.5 or 0.1 seconds
      this.repeatUpdateUserLocation.reset(1.0);
    });
  }
  createAndLogLocationAndHeading() {
    // Create location handler
    this.locationService = GeoLocation.createLocationService();

    // Set the accuracy
    this.locationService.accuracy = GeoLocationAccuracy.Navigation;

    // Acquire next location immediately with zero delay
    this.repeatUpdateUserLocation.reset(0.0);
  }
}