require('LensStudio:RawLocationModule');
import { PlayerClaims } from "./PlayerClaims";

@component
export class PlayerTracker extends BaseScriptComponent {
  latitude: number;
  longitude: number;
  prevlatitude: number;
  prevlongitude: number;
  horizontalAccuracy: number;
  verticalAccuracy: number;
  timestamp: Date;
  locationSource: string;
  
  HomeCoords: { latitude: number; longitude: number } | { latitude: 0, longitude: 0 };
    

  private repeatUpdateUserLocation: DelayedCallbackEvent;
  private playerUpdate: DelayedCallbackEvent;
  private locationService: LocationService;
    
  @input 
  playerClaim: PlayerClaims;

  onAwake() {
    this.createEvent('OnStartEvent').bind(() => {
      this.createAndLogLocation();
    });
        

    
    // repeatedly update position
    this.repeatUpdateUserLocation = this.createEvent('DelayedCallbackEvent');
    this.repeatUpdateUserLocation.bind(() => {
      // Get users location.
      this.locationService.getCurrentPosition(
        (geoPosition) => {
          // Check if location coordinates have been updated based on timestamp
          if (
            this.timestamp === undefined ||
            this.timestamp.getTime() !== geoPosition.timestamp.getTime()
          ) {
            //set previous lat and long to current lat and long before setting new coords
            this.prevlatitude = this.latitude;
            this.prevlongitude = this.longitude
            this.latitude = geoPosition.latitude;
            this.longitude = geoPosition.longitude;
            if ((this.prevlatitude == undefined || this.prevlongitude == undefined) && (this.latitude != undefined || this.longitude != undefined)){
                 this.HomeCoords = { latitude: this.latitude, longitude: this.longitude };     
                 this.createHomePoint(); //this should only happen once (prev points will be set below)
             }
            this.horizontalAccuracy = geoPosition.horizontalAccuracy;
            this.verticalAccuracy = geoPosition.verticalAccuracy;
            print('new long: ' + this.longitude);
            print('new lat: ' + this.latitude);
            //create stake in new location (if applicable)
            this.playerClaim.updatePos(this.latitude, this.longitude);
            this.timestamp = geoPosition.timestamp;
          }
        },
        (error) => {
          print(error);
        }
      );
      // Acquire next location update in 1 second
      this.repeatUpdateUserLocation.reset(1.0);
    });
        

  }

  // Function called on start
  createAndLogLocation() {
    // Create location handler
    this.locationService = GeoLocation.createLocationService();

    // Set the accuracy
    this.locationService.accuracy = GeoLocationAccuracy.Navigation;

    // Acquire next location immediately with zero delay to start loop
    this.repeatUpdateUserLocation.reset(0.0);
  }
  
  //function to spawn starter territory for player
  createHomePoint(){
     //this.HomeCoords is set right before this so spawn home area of player color
     this.playerClaim.createHomeClaim(this.latitude, this.longitude);
  }
  
  //returns true if prev and curr coords are defined
  hasPrevAndCurrCoords(){
     if (this.prevlatitude == undefined || this.prevlongitude == undefined || this.latitude == undefined || this.longitude == undefined){
         return false;
     }
     return true;
  }
  
    //getter for previous longitude
  getPrevLong(){
      return this.prevlongitude;
    }
    
    //getter for previous longitude
  getPrevLat(){
      return this.prevlatitude;
  }
    
    
  getPlayerColor(playerId: number): vec4 {
    // Convert the player ID to a hue value between 0-360 for variation
    let hue = (playerId * 137) % 360; // 137 ensures good distribution
    let saturation = 0.8; // Keep it vibrant
    let lightness = 0.5; // Medium brightness

    return this.hslToRgb(hue, saturation, lightness);
  }

  // Convert HSL to RGB (Lens Studio uses vec4 for colors)
  hslToRgb(h: number, s: number, l: number): vec4 {
    h /= 360;
    let r, g, b;

    if (s === 0) {
        r = g = b = l;
    } else {
        function hueToRgb(p: number, q: number, t: number) {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        }

        let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        let p = 2 * l - q;
        r = hueToRgb(p, q, h + 1 / 3);
        g = hueToRgb(p, q, h);
        b = hueToRgb(p, q, h - 1 / 3);
    }

    return new vec4(r, g, b, 1.0); // RGBA format
}

}
