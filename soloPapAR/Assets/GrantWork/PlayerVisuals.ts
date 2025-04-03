@component
export class PlayerVisuals extends BaseScriptComponent {
    
    @input
    uiText: Text; // Reference to the Text UI component
    
    onAwake() {

    }
    
    //function to display info as text on screen
    //this is called by grid claimer in update pos
    updateHUDText(lat: number, long: number, gridx: number, gridy: number, latOff: number, longOff: number): void {
        // Clamp latitude and longitude to 5 decimal places
        const clampedLat = lat.toFixed(5);
        const clampedLong = long.toFixed(5);
        const clampedgridx = gridx.toFixed(5);
        const clampedgridy = gridy.toFixed(5);
        const clampedlatOff = latOff.toFixed(5);
        const clampedlongOff = longOff.toFixed(5);
    
        print('HUD text has been updated');
        // Display the clamped coordinates and grid position
        this.uiText.text = 
            `Coordinates: (${clampedLat}, ${clampedLong})\n` + 
            `Grid Cell: (${clampedgridx}, ${clampedgridx})\n` + 
            `Offset: (${clampedlatOff}, ${clampedlongOff})`;
    }
}
