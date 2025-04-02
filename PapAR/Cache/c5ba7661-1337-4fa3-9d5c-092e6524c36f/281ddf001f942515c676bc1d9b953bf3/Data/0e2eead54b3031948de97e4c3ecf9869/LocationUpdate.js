"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocationExample = void 0;
var __selfType = requireType("./LocationUpdate");
function component(target) { target.getTypeName = function () { return __selfType; }; }
require('LensStudio:RawLocationModule');
let LocationExample = class LocationExample extends BaseScriptComponent {
    onAwake() {
        this.createEvent('OnStartEvent').bind(() => {
            this.createAndLogLocationAndHeading();
        });
        this.repeatUpdateUserLocation = this.createEvent('DelayedCallbackEvent');
        this.repeatUpdateUserLocation.bind(() => {
            // Get users location.
            this.locationService.getCurrentPosition(function (geoPosition) {
                //Check if location coordinates have been updated based on timestamp
                if (this.timestamp === undefined ||
                    this.timestamp.getTime() != geoPosition.timestamp.getTime()) {
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
            }, function (error) {
                print(error);
            });
            // Acquire next location update in 1 second, increase this value if required for AR visualisation purposes such as 0.5 or 0.1 seconds
            this.repeatUpdateUserLocation.reset(1.0);
        });
    }
    createAndLogLocationAndHeading() {
        // Create location handler
        this.locationService = GeoLocation.createLocationService();
        // Set the accuracy
        this.locationService.accuracy = GeoLocationAccuracy.Navigation;
        // Acquire heading orientation updates
        var onOrientationUpdate = function (northAlignedOrientation) {
            //Providing 3DoF north aligned rotation in quaternion form
            let heading = GeoLocation.getNorthAlignedHeading(northAlignedOrientation);
            print('Heading orientation: ' + heading.toFixed(3));
            // Convert to a 2DoF rotation for plane rendering purposes
            var rotation = (heading * Math.PI) / 180;
            print('Screen transform rotation: ' + quat.fromEulerAngles(0, 0, rotation));
        };
        this.locationService.onNorthAlignedOrientationUpdate.add(onOrientationUpdate);
        // Acquire next location immediately with zero delay
        this.repeatUpdateUserLocation.reset(0.0);
    }
};
exports.LocationExample = LocationExample;
exports.LocationExample = LocationExample = __decorate([
    component
], LocationExample);
//# sourceMappingURL=LocationUpdate.js.map