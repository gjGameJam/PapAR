@component
export class HorizonLineLens extends BaseScriptComponent {
    
    @input
    deviceTracking: DeviceTracking;
    @input
    horizonLineIMG: Image;
    
    horizonLineObj: SceneObject; //object to emulate horizon line
    
    prevRoll: number = 0; // Store last known rotation to only temporally update
    
    antiNauseaHUD : ScreenTransform;
    
    //when the transform is changed, update horizon lens
    onAfterTransformUpdated() {
        // Get rotation data from device tracking object
        var transform = this.deviceTracking.getTransform();
        var forward = transform.forward;
        var right = transform.right;
        var up = transform.up;
        //var yaw = Math.atan2(forward.z, forward.x)  + Math.PI // y rotation
        //var pitch = Math.asin(forward.y) * -1 // x rotation
        //get roll in degrees
        //var rollAngle = Math.atan2(right.y, right.x) * (180 / Math.PI); //check accuracy of roll calcs (like this)
        var roll = Math.atan2(right.y, up.y) * (180 / Math.PI); // This calculates the tilt/roll around the z-axis
        
        // Check if roll (side to side) has changed
        if (roll != this.prevRoll) {
            print("Roll Changed: " + roll);
            this.prevRoll = roll; // Update last known rotation
            //update horizon line UI with new rotation
            this.antiNauseaHUD.rotation = quat.fromEulerAngles(0, 0, roll);
            

        }
        
        
    }
    
    onAwake() {

    }
    
    //0 for transparent 1 for opaque (to be called from anti nausea settings in future)
    setHorizonLineTransparency(alpha) {
        if (!this.horizonLineIMG) {
            print("Image Component is missing!");
            return;
        }
    
        // Get current color and modify its alpha value
        var color = this.horizonLineIMG.mainPass.baseColor;
        color.a = alpha; // Alpha should be between 0 (fully transparent) and 1 (fully opaque)
    
        // Apply the new color back to the image
        this.horizonLineIMG.mainPass.baseColor = color;
    }
    
       
}
