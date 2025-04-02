@component
export class HorizonLineLens extends BaseScriptComponent {
    
    @input
    deviceTracking: DeviceTracking;
    @input
    horizonLineIMG: Image;
    
    horizonLineObj: SceneObject; //object to emulate horizon line
    
    prevPitch: number = 0;
    prevRoll: number = 0; // Store last known rotation to only temporally update
    smoothingFactor: number = 1; // Adjust for smoother motion (lower = smoother, higher = faster)    
    
    @input
    antiNauseaHUD : ScreenTransform;
    
    //function to update horizon line rotation to always stay parallel to IRL horizon
    onAfterTransformUpdated() {
        // Get rotation data from device tracking object
        const transform = this.deviceTracking.getTransform();
        if (!transform) {
            print("Error: DeviceTransform not available.");
            return;
        }

        // Extract the device's forward, right, and up vectors from the transform
        const right = transform.right;
        const up = transform.up;

        // Calculate roll (rotation around the z-axis)
        const roll = Math.atan2(right.y, up.y) * (180 / Math.PI); // Convert to degrees

        // Interpolate between the previous roll and the new roll for smoother transition
        this.prevRoll = this.prevRoll * (1 - this.smoothingFactor) + roll * this.smoothingFactor;

        // Convert degrees to radians for quaternion rotation
        const rollRadians = -this.prevRoll * (Math.PI / 180);

        // Apply the updated roll to the horizon line
        this.antiNauseaHUD.rotation = quat.fromEulerAngles(0, 0, rollRadians);
    }

    
    
    onAwake() {
        print("Horizon Line script awake");
        this.setHorizonLineTransparency(0.5); //set initial transparency
        this.createEvent("UpdateEvent").bind(this.onAfterTransformUpdated.bind(this));
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
