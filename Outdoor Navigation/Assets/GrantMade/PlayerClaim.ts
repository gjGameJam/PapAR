require('LensStudio:RawLocationModule');

@component
export class LocationExample extends BaseScriptComponent {
  latitude: number;
  longitude: number;
  altitude: number;
  horizontalAccuracy: number;
  verticalAccuracy: number;

  private repeatUpdateUserLocation: DelayedCallbackEvent;
  private locationService: LocationService;

  onAwake() {
    this.createEvent('OnStartEvent').bind(() => {
      this.createAndLogLocation();
    });

    // Set up the periodic update for location
    this.repeatUpdateUserLocation = this.createEvent('DelayedCallbackEvent');
    this.repeatUpdateUserLocation.bind(() => {
      // Get user's location continuously
      this.locationService.getCurrentPosition(
        function (geoPosition) {
          // Directly update coordinates and print without timestamp check
          this.latitude = geoPosition.latitude;
          this.longitude = geoPosition.longitude;
          this.horizontalAccuracy = geoPosition.horizontalAccuracy;
          this.verticalAccuracy = geoPosition.verticalAccuracy;

          // Print the coordinates every time location is fetched
          print('Longitude: ' + this.longitude);
          print('Latitude: ' + this.latitude);
        },
        function (error) {
          print('Error: ' + error);
        }
      );

      // Reset the event every 1 second (you can change this for faster updates)
      this.repeatUpdateUserLocation.reset(1.0);
    });

    // Start updating location immediately
    this.repeatUpdateUserLocation.reset(0.0);
  }

  createAndLogLocation() {
    // Create location handler
    this.locationService = GeoLocation.createLocationService();

    // Set accuracy to navigation level
    this.locationService.accuracy = GeoLocationAccuracy.Navigation;
  }
}
