@component
export class DockingGlassesLens extends BaseScriptComponent {
    
    @input
    deviceTracking: DeviceTracking;
    
    onUpdate(eventData) {
    if (!this.deviceTracking) {
        print("Device Tracking component is missing!");
        return;
    }
    
//        // Get acceleration data
//        var acceleration = this.deviceTracking.getAcceleration();
//        print("Acceleration: " + acceleration.toString());
//    
//        // Get rotation data
//        var rotation = this.deviceTracking.getRotation();
//        print("Rotation: " + rotation.toString());
//    
//        // Get gyroscope (angular velocity)
//        var angularVelocity = this.deviceTracking.getAngularVelocity();
//        print("Angular Velocity: " + angularVelocity.toString());
    }

    onAwake() {

    }
    
    
    
}
