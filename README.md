# vr-floorplan

WebXR walkthrough of a floor plan model, for viewing in the Quest browser (standalone).

- `house.glb`: model exported from Blender (meters, Y-up)
- `main.js`: three.js scene, VR locomotion
- `vendor/three/`: three.js r180 (only the files used)

## Controls

- **VR, hand tracking**: right hand pinch and hold to aim (green ray and ring on the floor), release to
  teleport there. Twist your wrist while aiming to choose which way you'll face on landing (arrow on the
  ring, 30° steps, twist counts double). Left hand pinch steps to the next variant; left pinch and drag
  sideways snaps 30° per 10 cm instead (drag right = turn right).
- **VR, controllers**: left stick to move (in the direction you're looking), right stick for 30° snap
  turns, right trigger to aim/teleport, A/X (or left trigger) for the next variant.
- **Desktop**: drag to orbit, scroll to zoom, `L` or the button for the next variant. URL options:
  `?spawn` previews the VR start position, `?v=2` starts on variant step 2.

## Variants

Nodes in `house.glb` with `group` / `index` / `label` extras are alternative options (living layout,
shower bench, nightstands). One step counter drives every group: each shows option `step mod count`,
so all combinations repeat every lcm(counts) steps. A toast lists the current option of each group.

## Local preview

```sh
python3 -m http.server 8765   # then open http://localhost:8765
```
