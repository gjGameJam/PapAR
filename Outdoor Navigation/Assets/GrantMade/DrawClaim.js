//// Get the scene object this script is attached to
//const sceneObject = script.getSceneObject();
//
//if (!sceneObject) {
//    print("No scene object found for this script.");
//} else {
//    print("Scene object attached: " + sceneObject.name);
//    
//    // List all components attached to this scene object
//    const components = sceneObject.getComponent("Component.ScriptComponent");
//    print("Script components attached: " + components.getCoordinates());
//
//    // If PlayerCoords component exists, print its details
//    if (components.length > 0) {
//        const playerCoords = components[0]; // Access the first PlayerCoords component
//        print("PlayerCoords component found!");
//
//        // You can now use the playerCoords object for its methods or properties
//        const coords = playerCoords.getPlayerCoordinates();
//        print("Latitude: " + coords.latitude + ", Longitude: " + coords.longitude);
//    } else {
//        print("No PlayerCoords component found on the scene object.");
//    }
//}
//
////    print("Components attached to this scene object:");
////    
////    for (let i = 0; i < components.length; i++) {
////        print("Component " + i + ": " + components[i].constructor.name);
////    }
////
////    // Get the PlayerCoords component
////    const playerCoords = sceneObject.getComponent('PlayerCoords');
////    
////    if (playerCoords) {
////        script.createEvent('DelayedCallbackEvent').bind(() => {
////            const coordinates = playerCoords.getCoordinates();
////            
////            // Debugging: Print the coordinates
////            print('Latitude: ' + coordinates.latitude + ', Longitude: ' + coordinates.longitude);
////        });
////    } else {
////        print("PlayerCoords component not found on this scene object.");
////    }
//
//