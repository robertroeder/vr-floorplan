# vr-floorplan

WebXR walkthrough of a floor plan model, for viewing in the Quest browser (standalone).

- `house.glb`: model exported from Blender (meters, Y-up)
- `main.js`: three.js scene, VR locomotion
- `vendor/three/`: three.js r180 (only the files used)

## Controls

- **VR, hand tracking**: right hand pinch and hold to aim (green ray and ring on the floor), release to
  teleport there. Left hand pinch switches the furniture layout. Turn by turning your body.
- **VR, controllers**: left stick to move (in the direction you're looking), right stick for 30° snap
  turns, right trigger to aim/teleport, A/X (or left trigger) to switch layout.
- **Desktop**: drag to orbit, scroll to zoom, `L` or the button to switch layout. URL options:
  `?spawn` previews the VR start position, `?layout=B` starts on layout B.

## Local preview

```sh
python3 -m http.server 8765   # then open http://localhost:8765
```
