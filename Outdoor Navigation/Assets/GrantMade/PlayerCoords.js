require('LensStudio:RawLocationModule');

// Initialize locationService and timestamp for last location update
let locationService = null;
let timestampLastLocation = null;  // Define the timestamp variable

// Event to update location periodically
const repeatUpdateUserLocation = script.createEvent('DelayedCallbackEvent');
repeatUpdateUserLocation.bind(() => {
    // Get user's location
    locationService.getCurrentPosition(
        function (geoPosition) {
            // Check if location coordinates have been updated based on timestamp
            let geoPositionTimestampMs = geoPosition.timestamp.getTime();
            if (timestampLastLocation !== geoPositionTimestampMs) {
                script.latitude = geoPosition.latitude;
                script.longitude = geoPosition.longitude;
                script.horizontalAccuracy = geoPosition.horizontalAccuracy;
                script.verticalAccuracy = geoPosition.verticalAccuracy;  // Fixed property name here
                print('lat: ' + geoPosition.latitude);
                print('long: ' + geoPosition.longitude);

                //print('location source: ' + geoPosition.locationSource);
                timestampLastLocation = geoPositionTimestampMs;  // Update timestamp
            }
        }
        function (error) {
            print('Error getting location: ' + error);  // More descriptive error message
        }
    );

    // Set the next location update in 1 second
    repeatUpdateUserLocation.reset(1.0);
});

// Function to create location service and log heading
function createAndLogLocationAndHeading() {
    // Create location handler
    locationService = GeoLocation.createLocationService();

    // Set accuracy to Navigation for better precision
    locationService.accuracy = GeoLocationAccuracy.Navigation;

    // Get the scene object where we want to set the rotation
    const sceneObject = script.getSceneObject();

    // Ensure the scene object has a transform component to set rotation
    if (sceneObject && sceneObject.getTransform) {
        // Handling heading updates
        const onOrientationUpdate = function (northAlignedOrientation) {
            let heading = GeoLocation.getNorthAlignedHeading(northAlignedOrientation);
            //print('Heading orientation: ' + heading.toFixed(3));

            // Convert to a 2DoF rotation for plane rendering purposes
            const rotation = (heading * Math.PI) / 180;

            // Set the rotation of the scene object
            const transform = sceneObject.getTransform();
            if (transform) {
                transform.rotation = quat.fromEulerAngles(0, 0, rotation);
            } else {
                print('Error: Scene object does not have a transform component.');
            }
        };

        locationService.onNorthAlignedOrientationUpdate.add(onOrientationUpdate);

        // Reset to immediately start location updates
        repeatUpdateUserLocation.reset(0.0);
    } else {
        print('Error: Scene object does not exist or does not have a transform component.');
    }
}

// Start event to initialize location and heading logging
script.createEvent('OnStartEvent').bind(() => {
    createAndLogLocationAndHeading();
});

// Public getter method to access latitude and longitude
script.getCoordinates = function() {
    return {
        latitude: script.latitude,
        longitude: script.longitude
    };
};
