# vr-floorplan

WebXR walkthrough of a floor plan model, for viewing in the Quest browser (standalone).

- `house.glb`: model exported from Blender (meters, Y-up)
- `main.js`: three.js scene, VR locomotion
- `vendor/three/`: three.js r180 (only the files used)

## Controls

- **VR**: left stick to move (in the direction you're looking), right stick for 30° snap turns
- **Desktop**: drag to orbit, scroll to zoom. Add `?spawn` to the URL to preview the VR start position.

## Local preview

```sh
python3 -m http.server 8765   # then open http://localhost:8765
```
