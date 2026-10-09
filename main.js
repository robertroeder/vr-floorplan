import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

// Model is exported from Blender in meters, glTF Y-up: Blender +Y (north) -> three -Z.
const SPAWN = new THREE.Vector3(7.97, 0, -5.58);  // kitchen/living threshold, facing north toward the bay
const MOVE_SPEED = 1.5;                          // m/s
const SNAP_ANGLE = THREE.MathUtils.degToRad(30);
const DEADZONE = 0.2;
const TELEPORT_RANGE = 12;                       // m
const SWIPE_GAIN = THREE.MathUtils.degToRad(30) / 0.10;  // left-pinch drag turn: 30° per 10 cm, continuous
const SWIPE_DEADZONE = 0.03;                     // m of drag before a pinch counts as a swipe (not a tap)
const TWIST_GAIN = 2;                            // landing-facing turn per unit of wrist twist while aiming
const UP = THREE.Object3D.DEFAULT_UP;
// Head pose in VR: use `camera` (in the rig; three copies the headset pose into it each frame).
// renderer.xr.getCamera() has no parent, so its getWorldPosition() is relative to the rig, not the world.
const HINT = [
  'Right pinch: aim, twist wrist to face, release to move',
  'Left pinch: next variant  ·  pinch + swipe sideways: turn',
];

const status = document.getElementById('status');

// ---- renderer / scene ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setFoveation(1);
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] }));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb8d4e8);

scene.add(new THREE.HemisphereLight(0xeef4ff, 0x8a7a66, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-8, 15, 6);  // from the south-west
scene.add(sun);

// ---- camera rig: move the rig to locomote, the headset moves the camera inside it ----
const rig = new THREE.Group();
scene.add(rig);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
rig.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
const camParam = new URLSearchParams(location.search).get('cam');  // ?cam=x,y,z,tx,ty,tz (m, three coords)
if (camParam) {
  const [x, y, z, tx, ty, tz] = camParam.split(',').map(Number);
  camera.position.set(x, y, z);
  controls.target.set(tx, ty, tz);
} else if (new URLSearchParams(location.search).has('spawn')) {
  // preview the VR start position at eye height
  camera.position.copy(SPAWN).setY(1.6);
  controls.target.copy(SPAWN).add(new THREE.Vector3(0, 1.4, -2));
} else {
  camera.position.set(7.5, 14, 4);
  controls.target.set(7.5, 0, -5.5);
}
controls.update();

// ---- floating text panel shown in front of the user in VR ----
const toast = makeToast();
scene.add(toast.mesh);

function makeToast() {
  const canvas = document.createElement('canvas');
  const LINE_H = 72, MAX_LINES = 6;
  canvas.width = 1024; canvas.height = LINE_H * MAX_LINES;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.8 * canvas.height / canvas.width),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  mesh.renderOrder = 10;
  mesh.visible = false;
  let hideAt = 0;
  const head = new THREE.Vector3();
  const dir = new THREE.Vector3();
  return {
    mesh,
    show(text, seconds = 2.5) {  // text: string or array of lines (top-aligned)
      if (!renderer.xr.isPresenting) return;
      const lines = [].concat(text).slice(0, MAX_LINES);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(0, 0, canvas.width, LINE_H * lines.length);
      ctx.fillStyle = '#fff';
      ctx.font = '40px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, LINE_H * (i + 0.5)));
      tex.needsUpdate = true;
      // 1.2 m in front of the head, slightly below eye level, facing the user
      camera.getWorldPosition(head);
      camera.getWorldDirection(dir);
      dir.y = 0; dir.normalize();
      mesh.position.copy(head).addScaledVector(dir, 1.2).add(new THREE.Vector3(0, -0.15, 0));
      mesh.lookAt(head.x, mesh.position.y, head.z);
      mesh.visible = true;
      hideAt = performance.now() + seconds * 1000;
    },
    update() {
      if (mesh.visible && performance.now() > hideAt) mesh.visible = false;
    },
  };
}

// ---- variants (left pinch / X / A in VR, L key or button on desktop) ----
// Every node with a "group" extra is one option of that group (living layout, shower bench, ...).
// One step counter drives all groups; each shows option (step mod its option count).
const layoutBtn = document.createElement('button');
layoutBtn.style.cssText = 'position:absolute;top:12px;right:12px;padding:6px 10px;font:13px system-ui;' +
  'border:0;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;display:none;' +
  'max-width:min(70vw, 900px);text-align:right';
document.body.appendChild(layoutBtn);
let groups = [];  // [{ name, options: [node, ...] }]
let period = 1;   // steps until every group is back at its first option
let step = 0;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

function initVariants(root) {
  const byName = new Map();
  root.traverse((o) => {
    const g = o.userData.group;
    if (g === undefined) return;
    if (!byName.has(g)) byName.set(g, []);
    byName.get(g).push(o);
  });
  groups = [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, options]) => ({
    name, options: options.sort((a, b) => a.userData.index - b.userData.index),
  }));
  period = groups.reduce((p, g) => (p * g.options.length) / gcd(p, g.options.length), 1);
}

function setStep(n) {
  if (!groups.length) return;
  step = ((n % period) + period) % period;
  const lines = groups.map((g) => {
    const k = step % g.options.length;
    g.options.forEach((o, j) => { o.visible = j === k; });
    return `${g.name}: ${g.options[k].userData.label ?? k}`;
  });
  layoutBtn.textContent = `${step + 1}/${period}  ${lines.join('  ·  ')}  (L: next)`;
  toast.show(lines);
}
layoutBtn.addEventListener('click', () => setStep(step + 1));
window.addEventListener('keydown', (e) => { if (e.key === 'l' || e.key === 'L') setStep(step + 1); });

// ---- model ----
// Quest 1 is weak: swap PBR/transmission materials for cheap Lambert / basic ones.
const teleportSurfaces = [];  // the ground (at grade, ~1.2 m below the floor) is part of house.glb
new GLTFLoader().load('./house.glb', (gltf) => {
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    if (src.transparent || src.name.includes('Glass')) {
      o.material = new THREE.MeshBasicMaterial({
        color: 0x9fd0ff, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
      });
      o.renderOrder = 1;  // glass (windows, shower) doesn't block the teleport ray
    } else {
      o.material = new THREE.MeshLambertMaterial({ color: src.color, side: THREE.DoubleSide });
      teleportSurfaces.push(o);  // walls / furniture block the ray; only floor hits are valid targets
    }
  });
  scene.add(gltf.scene);
  initVariants(gltf.scene);
  if (groups.length) {
    layoutBtn.style.display = '';
    setStep(Number(new URLSearchParams(location.search).get('v')) || 0);  // ?v=<step>
  }
  status.textContent = navigator.xr ? 'Ready: press Enter VR' : 'Ready (no WebXR in this browser)';
  if (walkParam !== null) startWalk();
}, undefined, (err) => {
  status.textContent = 'Failed to load model';
  console.error(err);
});

// ---- input: controllers and tracked hands ----
// Pinch (hands) and trigger (controllers) both fire 'select' on the target-ray space.
// Right select: hold to aim a teleport ray, release to jump. Left select: next variant.
const controllerModels = new XRControllerModelFactory();
const handModels = new XRHandModelFactory();
const pointers = [];

for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModels.createControllerModel(grip));
  rig.add(grip);

  const hand = renderer.xr.getHand(i);
  hand.add(handModels.createHandModel(hand, 'mesh'));
  rig.add(hand);

  const ray = renderer.xr.getController(i);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x66ff99 }),
  );
  line.visible = false;
  ray.add(line);
  rig.add(ray);

  // left select: a quick pinch (or trigger) = next variant; pinch + sideways drag = smooth turn instead
  const p = { ray, line, hand, handedness: null, aiming: false, target: null, facing: 0,
              twistUp0: null, swiping: false, swiped: false, anchor: new THREE.Vector3() };
  pointers.push(p);
  ray.addEventListener('connected', (e) => { p.handedness = e.data.handedness; });
  ray.addEventListener('disconnected', () => {
    p.handedness = null; p.aiming = false; p.swiping = false; line.visible = false;
  });
  ray.addEventListener('selectstart', () => {
    if (p.handedness === 'right') {
      p.aiming = true;
      p.facing = 0;
      p.twistUp0 = twistFrame(p).up.clone();
    } else if (p.handedness === 'left') {
      p.swiping = true;
      p.swiped = false;
      p.anchor.copy(ray.position);  // rig-local, so turning the rig doesn't move it
    }
  });
  ray.addEventListener('selectend', () => {
    if (p.aiming && p.target) teleportTo(p.target, p.facing);
    if (p.swiping && !p.swiped) setStep(step + 1);
    p.aiming = false;
    p.swiping = false;
    p.target = null;
    line.visible = false;
    marker.visible = false;
  });
}

// Wrist frame for the teleport twist: the hand's wrist joint when hand tracking (its -Z runs along the
// hand, +Y out of the back of the hand), else the controller's target ray.
const twistFwd = new THREE.Vector3();
const twistUp = new THREE.Vector3();
function twistFrame(p) {
  const wrist = p.hand.joints?.wrist;
  const src = wrist && wrist.visible ? wrist : p.ray;
  src.getWorldQuaternion(tmpQuat);
  return { fwd: twistFwd.set(0, 0, -1).applyQuaternion(tmpQuat), up: twistUp.set(0, 1, 0).applyQuaternion(tmpQuat) };
}

// Signed wrist twist (radians, + = counter-clockwise as the user sees it) since the pinch started.
const twistA = new THREE.Vector3();
const twistB = new THREE.Vector3();
function wristTwist(p) {
  const { fwd, up } = twistFrame(p);
  twistA.copy(p.twistUp0).projectOnPlane(fwd);
  twistB.copy(up).projectOnPlane(fwd);
  if (twistA.lengthSq() < 1e-6 || twistB.lengthSq() < 1e-6) return 0;
  // right-hand rule about fwd (pointing away from the user) is clockwise as seen from behind
  return -Math.atan2(twistA.clone().cross(twistB).dot(fwd), twistA.dot(twistB));
}

function updateSwipe(p) {
  // sideways hand travel along the head's right vector, in rig-local space (turning the rig doesn't
  // move the hand there). Past the dead zone, the view turns with the hand: drag right = turn right.
  camera.getWorldDirection(fwd);
  fwd.applyQuaternion(tmpQuat.copy(rig.quaternion).invert());
  fwd.y = 0; fwd.normalize();
  right.crossVectors(fwd, UP).normalize();
  const dx = tmpDir.copy(p.ray.position).sub(p.anchor).dot(right);
  if (!p.swiped) {
    if (Math.abs(dx) < SWIPE_DEADZONE) return;
    p.swiped = true;
  } else {
    snapTurn(-dx * SWIPE_GAIN);
  }
  p.anchor.copy(p.ray.position);
}

function snapTurn(angle) {
  // rotate the rig around the head so the user turns in place (+angle = turn left)
  camera.getWorldPosition(headPos);
  rig.position.sub(headPos).applyAxisAngle(UP, angle).add(headPos);
  rig.rotation.y += angle;
}

const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.18, 0.25, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x66ff99, depthTest: false, transparent: true, opacity: 0.9 }),
);
marker.renderOrder = 9;
marker.visible = false;
scene.add(marker);
// arrow on the ring: which way you'll face after the teleport (marker.rotation.y = landing yaw)
const markerArrow = new THREE.Mesh(
  new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, -0.48), new THREE.Vector3(-0.11, 0, -0.29), new THREE.Vector3(0.11, 0, -0.29),
  ]),
  marker.material,
);
markerArrow.material.side = THREE.DoubleSide;
markerArrow.renderOrder = 9;
marker.add(markerArrow);

const raycaster = new THREE.Raycaster();
raycaster.far = TELEPORT_RANGE;
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpDir = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();

function visibleInScene(o) {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function updateAim(p) {
  p.ray.getWorldPosition(tmpPos);
  p.ray.getWorldQuaternion(tmpQuat);
  tmpDir.set(0, 0, -1).applyQuaternion(tmpQuat);
  raycaster.set(tmpPos, tmpDir);
  const hit = raycaster.intersectObjects(teleportSurfaces, false).find((h) => visibleInScene(h.object));
  let valid = false;
  if (hit) {
    tmpNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    valid = tmpNormal.y > 0.7 && hit.point.y < 0.15;  // floors, decks, stairs, ground; not furniture tops
  }
  const len = hit ? hit.distance : TELEPORT_RANGE;
  p.line.scale.z = len;
  p.line.material.color.set(valid ? 0x66ff99 : 0xff6666);
  p.line.visible = true;
  p.target = valid ? hit.point.clone() : null;
  marker.visible = valid;
  if (!valid) return;
  marker.position.copy(hit.point).setY(hit.point.y + 0.01);
  // landing facing: current head yaw plus the wrist twist, in snap-angle steps
  const twist = TWIST_GAIN * wristTwist(p);
  p.facing = THREE.MathUtils.clamp(Math.round(twist / SNAP_ANGLE) * SNAP_ANGLE, -Math.PI, Math.PI);
  camera.getWorldDirection(fwd);
  marker.rotation.y = Math.atan2(-fwd.x, -fwd.z) + p.facing;
}

const headPos = new THREE.Vector3();
function teleportTo(point, facing = 0) {
  // move the rig so the user's head ends up above the target point, standing on it (stairs, yard),
  // then turn it about that point by `facing` (+ = left)
  camera.getWorldPosition(headPos);
  rig.position.x += point.x - headPos.x;
  rig.position.z += point.z - headPos.z;
  rig.position.y = point.y;
  if (facing) {
    tmpPos.set(point.x, rig.position.y, point.z);
    rig.position.sub(tmpPos).applyAxisAngle(UP, facing).add(tmpPos);
    rig.rotation.y += facing;
  }
}

// ---- desktop first-person walk: Walk button (or F) locks the mouse; WASD / arrows move, Shift runs, Esc stops ----
// Feet follow the floor (stairs, decks, yard) and walls / furniture block you; glass doesn't.
// ?walk=x,z,yawDeg starts walking there without pointer lock (for headless checks; keys still work).
const EYE_HEIGHT = 1.6;
const WALK_SPEED = 1.4;          // m/s; Shift = x2.5
const STEP_UP = 0.3;             // tallest step you walk up (stair risers are 0.22 m)
const BODY_RADIUS = 0.25;
const LOOK_SENS = 0.0022;        // rad per pixel of mouse movement
const BLOCK_HEIGHTS = [STEP_UP + 0.05, 1.0, 1.7];  // above the feet; door headers are at 2.03 m

const walkBtn = document.createElement('button');
walkBtn.style.cssText = 'position:absolute;bottom:12px;left:12px;padding:6px 10px;font:13px system-ui;' +
  'border:0;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;cursor:pointer';
walkBtn.textContent = 'Walk (F)';
document.body.appendChild(walkBtn);

const walk = { active: false, feet: SPAWN.clone(), yaw: 0, pitch: 0, vy: 0, keys: new Set(), orbitCam: null };
const walkRay = new THREE.Raycaster();
const walkDir = new THREE.Vector3();
const walkOrigin = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

function startWalk() {
  if (walk.active || renderer.xr.isPresenting) return;
  walk.active = true;
  walk.orbitCam = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
  controls.enabled = false;
  camera.rotation.order = 'YXZ';
  walkBtn.textContent = 'WASD / arrows: move  ·  mouse: look  ·  Shift: run  ·  L: next variant  ·  Esc: stop';
}

function stopWalk() {
  if (!walk.active) return;
  walk.active = false;
  walk.keys.clear();
  camera.rotation.order = 'XYZ';
  camera.position.copy(walk.orbitCam.pos);
  camera.quaternion.copy(walk.orbitCam.quat);
  controls.enabled = true;
  walkBtn.textContent = 'Walk (F)';
}

const requestWalk = () => renderer.domElement.requestPointerLock();
walkBtn.addEventListener('click', (e) => { if (!walk.active) requestWalk(); e.currentTarget.blur(); });
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === renderer.domElement) startWalk(); else stopWalk();
});
document.addEventListener('mousemove', (e) => {
  if (!walk.active || document.pointerLockElement !== renderer.domElement) return;
  walk.yaw -= e.movementX * LOOK_SENS;
  walk.pitch = THREE.MathUtils.clamp(walk.pitch - e.movementY * LOOK_SENS, -1.45, 1.45);
});
window.addEventListener('keydown', (e) => {
  if (!walk.active) {
    if (e.code === 'KeyF') requestWalk();
    return;
  }
  if (e.code === 'Escape') { document.exitPointerLock(); stopWalk(); return; }  // ?walk has no lock to release
  walk.keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => walk.keys.delete(e.code));
window.addEventListener('blur', () => walk.keys.clear());

const walkParam = new URLSearchParams(location.search).get('walk');  // ?walk=x,z,yawDeg (three coords)
if (walkParam !== null) {
  const [x, z, yaw] = walkParam.split(',').map(Number);
  if (Number.isFinite(x) && Number.isFinite(z)) walk.feet.set(x, 0, z);
  walk.yaw = THREE.MathUtils.degToRad(yaw || 0);
}

function firstVisibleHit(origin, dir, far) {
  walkRay.set(origin, dir);
  walkRay.far = far;
  return walkRay.intersectObjects(teleportSurfaces, false).find((h) => visibleInScene(h.object));
}

// Height of the walkable surface under (x, z), searching down from a step above the feet; null if none.
function floorAt(x, z) {
  const hit = firstVisibleHit(walkOrigin.set(x, walk.feet.y + STEP_UP, z), DOWN, 50);
  if (!hit) return null;
  tmpNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
  return tmpNormal.y > 0.7 ? hit.point.y : null;
}

function blocked(dx, dz) {
  const dist = Math.hypot(dx, dz);
  walkDir.set(dx / dist, 0, dz / dist);
  return BLOCK_HEIGHTS.some((h) => firstVisibleHit(
    walkOrigin.set(walk.feet.x, walk.feet.y + h, walk.feet.z), walkDir, dist + BODY_RADIUS));
}

function tryMove(dx, dz) {
  if (Math.abs(dx) + Math.abs(dz) < 1e-6 || blocked(dx, dz)) return;
  if (floorAt(walk.feet.x + dx, walk.feet.z + dz) === null) return;  // off the edge of the world
  walk.feet.x += dx;
  walk.feet.z += dz;
}

function updateWalk(dt) {
  const k = walk.keys;
  const f = (k.has('KeyW') || k.has('ArrowUp')) - (k.has('KeyS') || k.has('ArrowDown'));
  const s = (k.has('KeyD') || k.has('ArrowRight')) - (k.has('KeyA') || k.has('ArrowLeft'));
  if (f || s) {
    // yaw 0 faces -Z (north); + yaw turns left
    const step = WALK_SPEED * (k.has('ShiftLeft') || k.has('ShiftRight') ? 2.5 : 1) * dt;
    const sin = Math.sin(walk.yaw), cos = Math.cos(walk.yaw);
    const mx = -sin * f + cos * s, mz = -cos * f - sin * s;
    const n = Math.hypot(mx, mz);
    tryMove(mx / n * step, 0);  // one axis at a time, so you slide along walls
    tryMove(0, mz / n * step);
  }
  const floor = floorAt(walk.feet.x, walk.feet.z);
  if (floor !== null) {
    if (walk.feet.y - floor <= STEP_UP) {  // stand on it (up or down a step)
      walk.feet.y = floor;
      walk.vy = 0;
    } else {                               // fall (off the deck edge, down the stairwell)
      walk.vy -= 9.8 * dt;
      walk.feet.y = Math.max(floor, walk.feet.y + walk.vy * dt);
    }
  }
  camera.position.set(walk.feet.x, walk.feet.y + EYE_HEIGHT, walk.feet.z);
  camera.rotation.set(walk.pitch, walk.yaw, 0);
}

// ---- entering / leaving VR ----
let desktopCam = null;
renderer.xr.addEventListener('sessionstart', () => {
  if (walk.active) { stopWalk(); document.exitPointerLock(); }
  desktopCam = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
  controls.enabled = false;
  rig.position.copy(SPAWN);
  rig.rotation.set(0, 0, 0);
  status.style.display = 'none';
  setTimeout(() => toast.show(HINT, 6), 500);  // wait for the first XR pose
});
renderer.xr.addEventListener('sessionend', () => {
  rig.position.set(0, 0, 0);
  rig.rotation.set(0, 0, 0);
  camera.position.copy(desktopCam.pos);
  camera.quaternion.copy(desktopCam.quat);
  controls.enabled = true;
  status.style.display = '';
  toast.mesh.visible = false;
});

// ---- controller sticks: left = move (head-relative), right = snap turn; A/X = next variant ----
const clock = new THREE.Clock();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
let snapReady = true;
const buttonWasDown = {};

function stick(gp) {
  // xr-standard mapping: thumbstick on axes 2/3 (fall back to 0/1)
  const x = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] ?? 0;
  const y = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] ?? 0;
  return { x: Math.abs(x) > DEADZONE ? x : 0, y: Math.abs(y) > DEADZONE ? y : 0 };
}

function locomote(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const src of session.inputSources) {
    if (!src.gamepad || src.hand) continue;
    const pressed = !!src.gamepad.buttons[4]?.pressed;
    if (pressed && !buttonWasDown[src.handedness]) setStep(step + 1);
    buttonWasDown[src.handedness] = pressed;
    const { x, y } = stick(src.gamepad);
    if (src.handedness === 'left' && (x || y)) {
      camera.getWorldDirection(fwd);
      fwd.y = 0; fwd.normalize();
      right.crossVectors(fwd, UP).normalize();
      rig.position.addScaledVector(fwd, -y * MOVE_SPEED * dt);
      rig.position.addScaledVector(right, x * MOVE_SPEED * dt);
    } else if (src.handedness === 'right') {
      if (snapReady && Math.abs(x) > 0.7) {
        snapTurn(-Math.sign(x) * SNAP_ANGLE);
        snapReady = false;
      } else if (Math.abs(x) < 0.3) {
        snapReady = true;
      }
    }
  }
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  locomote(dt);
  for (const p of pointers) {
    if (p.aiming) updateAim(p);
    if (p.swiping) updateSwipe(p);
  }
  toast.update();
  if (walk.active) updateWalk(dt);
  else if (!renderer.xr.isPresenting) controls.update();
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
