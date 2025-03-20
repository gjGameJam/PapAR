import { PlayerTracker } from "./PlayerTracker";

@component
export class PlayerClaims extends BaseScriptComponent {
    
    @input 
    playerCoords: PlayerTracker; //player coords and color data
    claimColor: vec4; //the color of this player's claim
    
    stakes: { lat: number, long: number }[] = [];
    claimedArea: { lat: number, long: number }[] = []; // One continuous shape

    
    //TODO: create representation of claimed area
    //TODO: create representation of staked area
    
 //1   private claimUpdate: DelayedCallbackEvent;

    onAwake() {
        this.claimColor = this.playerCoords.getPlayerColor(1); //guve id number 1 //TODO create id system
//2        this.createEvent('OnStartEvent').bind(() => {
//          this.startAllCallbacks();
//        });
        
//        // Create and bind event to repeatedly run
//        this.claimUpdate = this.createEvent('DelayedCallbackEvent');
//        this.claimUpdate.bind(() => {
//            
//          print("Claim");
//          this.claimUpdate.reset(1.0);
//        });
        

    }
    
    //function called on start that begins all callbacks
//3    startAllCallbacks(){
//        //repeat claim update
//        this.claimUpdate.reset(0);
//    }
    
    //called by player coords to create spawn point of player (first coord reading)
    createHomeClaim(lat: number, long: number){
        print("Home Claim Origin:" +  lat + long);
        //TODO: spawn home chunk of land around current pos
        //create local play zone around first player
    }
    
    //called by player coords when player coordinates change
    updatePos(lat: number, long: number){
        
        //TODO: spawn trail of stakes
        //check if in or outside of claimed territory   
        if (this.checkIfInTerritory(lat, long)){
          //if back inside, check if staking path exists and create/add new domain to current claim
          this.claimStakedLand();
          print("currently within claim:" +  lat + long);
        }
        else if (this.playerCoords.hasPrevAndCurrCoords()) { //if valid path (has prev and current coords), create stake trail
          print("new stake coords:" +  lat + long);
          //create new stake if outside territory then check for loop
          this.createNewStake(lat, long);
          //if staking path loops back into itself before reaching claimed territory, you die      
          if (this.checkForStakeLoop(this.stakes[this.stakes.length - 1], this.stakes[this.stakes.length])){
                //TODO: handle player death
            }
        }
        print("updatePos called");
    }

    
    //function that is called while touching home territory
    //if stakes exist, add associated new area to claim
    claimStakedLand(){
        //do nothing if there is no staked land
        if (this.stakes.length == 0){
            return;
        }
        
        //stake will always cross claim boundary on start on end of staking
        //so if the most recent line between stakes crosses the home claim, add to claim
        if (this.stakes.length > 1 && this.doesStakeCrossBoundary(this.stakes[this.stakes.length - 1], this.stakes[this.stakes.length])){
            //add region defined in stakes to claim and empty stakes
            
        }
        //TODO: add visual for claiming staked area
    }
    
    // Function to check if a point (latitude, longitude) is inside the polygon (claimed area)
    checkIfInTerritory(lat: number, long: number) {
        // Call the point-in-polygon check function to see if coords are in claim polygon
        return this.isPointInPolygon(lat, long, this.claimedArea);
    }



    
    //checks if player runs into another stake, which kills the owning player
    checkForStakeLoop(prevStake: { lat: number, long: number }, newStake: { lat: number, long: number }): boolean {
        for (let i = 0; i < this.stakes.length; i++) {
            let pointA = this.stakes[i];
            let pointB = this.stakes[(i + 1) % this.stakes.length]; // Next point (looping back)
    
            if (this.doLinesIntersect(prevStake, newStake, pointA, pointB)) {
                return true; // It crossed into a previous stake line
            }
        }
        return false;
    }
    
    //check if line from previous stake to new stake intersects claimed area
    doesStakeCrossBoundary(prevStake: { lat: number, long: number }, newStake: { lat: number, long: number }): boolean {
        for (let i = 0; i < this.claimedArea.length; i++) {
            let pointA = this.claimedArea[i];
            let pointB = this.claimedArea[(i + 1) % this.claimedArea.length]; // Next point (looping back)
    
            if (this.doLinesIntersect(prevStake, newStake, pointA, pointB)) {
                return true; // It crossed into the claim
            }
        }
        return false;
    }
    
    //helper function to see if line between two stakes and line between pointA and pointB cross each other
    doLinesIntersect(p1: { lat: number, long: number }, p2: { lat: number, long: number }, 
                 q1: { lat: number, long: number }, q2: { lat: number, long: number }): boolean {

    
        let d1 = this.crossProduct(q2.long - q1.long, q2.lat - q1.lat, p1.long - q1.long, p1.lat - q1.lat);
        let d2 = this.crossProduct(q2.long - q1.long, q2.lat - q1.lat, p2.long - q1.long, p2.lat - q1.lat);
        let d3 = this.crossProduct(p2.long - p1.long, p2.lat - p1.lat, q1.long - p1.long, q1.lat - p1.lat);
        let d4 = this.crossProduct(p2.long - p1.long, p2.lat - p1.lat, q2.long - p1.long, q2.lat - p1.lat);
    
        return (d1 * d2 < 0 && d3 * d4 < 0);
    }
    
    //helper cross product function
    crossProduct(a: number, b: number, c: number, d: number): number {
        return a * d - b * c;
    }

    // Ray-Casting Algorithm to check if the point is inside the polygon
    isPointInPolygon(lat: number, long: number, polygon: {lat: number, long: number}[]): boolean {
        let inside = false;
        let x = long, y = lat;
    
        // Iterate over the polygon's edges
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].long, yi = polygon[i].lat;
            const xj = polygon[j].long, yj = polygon[j].lat;
    
            // Check if point is inside the polygon
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
    
        return inside;
    }
    
    //function to stake new region
    createNewStake(lat: number, long: number){
        //get previous lat and long, get distance and direction between new and old to create trail
        let pLo = this.playerCoords.getPrevLong();
        let pLa = this.playerCoords.getPrevLat();
        let magnitude = this.getDistance(pLo, pLa, lat, long);
        let direction = this.getBearing(pLo, pLa, lat, long);//0 = north, 180 = south
        //add coords to stakes array
        this.stakes.push({ lat, long });
        //TODO: visually connect with previous stake
    }
    
    //gets the distance between coords via Haversine formula
    getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371000; // Radius of Earth in meters
        const rad = Math.PI / 180;
        
        let dLat = (lat2 - lat1) * rad;
        let dLon = (lon2 - lon1) * rad;
        
        let a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        
        let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        
        return R * c; // Distance in meters
    }
    
    //get degrees (0 being north 180 being south) between coords
    getBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
        let dLon = this.degToRad(lon2 - lon1);
        
        let y = Math.sin(dLon) * Math.cos(this.degToRad(lat2));
        let x = Math.cos(this.degToRad(lat1)) * Math.sin(this.degToRad(lat2)) - 
                Math.sin(this.degToRad(lat1)) * Math.cos(this.degToRad(lat2)) * Math.cos(dLon);
        
        let brng = Math.atan2(y, x);
        return (brng * (180 / Math.PI) + 360) % 360; // Convert to degrees and normalize
    }
    
    //helper function to convert degrees to radians
    degToRad(degrees: number): number {
        return degrees * (Math.PI / 180);
    }
    
    
    
}
