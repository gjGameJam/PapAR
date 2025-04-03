@component
export class PlayerVisuals extends BaseScriptComponent {
    
    @input
    uiText: Text; // Reference to the Text UI component
    
    onAwake() {

    }
    
    //function to display info as text on screen
    //this is called by grid claimer in update pos
    updateHUDText(lat: number, long: number, gridx: number, gridy: number): void {
        // Clamp latitude and longitude to 5 decimal places
        const clampedLat = lat.toFixed(5);
        const clampedLong = long.toFixed(5);
    
        print('HUD text has been updated');
        // Display the clamped coordinates and grid position
        this.uiText.text = `Coordinates: (${clampedLat}, ${clampedLong})\n` +
                           `Grid Position: (${gridx}, ${gridy})`;
    }
}
