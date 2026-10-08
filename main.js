import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// Model is exported from Blender in meters, glTF Y-up: Blender +Y (north) -> three -Z.
const SPAWN = new THREE.Vector3(7.97, 0, -5.58);  // kitchen/living threshold, facing north toward the bay
const LAYOUTS = ['LayoutA', 'LayoutB'];          // alternative furniture layouts (parent nodes in house.glb)
const MOVE_SPEED = 1.5;                          // m/s
const SNAP_ANGLE = THREE.MathUtils.degToRad(30);
const DEADZONE = 0.2;

const status = document.getElementById('status');

// ---- renderer / scene ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setFoveation(1);
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb8d4e8);

scene.add(new THREE.HemisphereLight(0xeef4ff, 0x8a7a66, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-8, 15, 6);  // from the south-west
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshLambertMaterial({ color: 0x7d9a6a }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.03;  // just under the floor slab
scene.add(ground);

// ---- camera rig: move the rig to locomote, the headset moves the camera inside it ----
const rig = new THREE.Group();
scene.add(rig);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
rig.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
if (new URLSearchParams(location.search).has('spawn')) {
  // preview the VR start position at eye height
  camera.position.copy(SPAWN).setY(1.6);
  controls.target.copy(SPAWN).add(new THREE.Vector3(0, 1.4, -2));
} else {
  camera.position.set(7.5, 14, 4);
  controls.target.set(7.5, 0, -5.5);
}
controls.update();

// controllers (models are fetched from the WebXR input profiles CDN)
const controllerModels = new XRControllerModelFactory();
for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModels.createControllerModel(grip));
  grip.addEventListener('connected', (e) => {
    if (e.data.handedness === 'left') grip.add(layoutLabel.mesh);
  });
  rig.add(grip);
}

// ---- layout switching (A/X button in VR, L key or button on desktop) ----
const layoutLabel = makeLabel();
const layoutBtn = document.createElement('button');
layoutBtn.style.cssText = 'position:absolute;top:12px;right:12px;padding:6px 10px;font:13px system-ui;' +
  'border:0;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;display:none';
document.body.appendChild(layoutBtn);
let layoutNodes = [];
let layoutIdx = 0;

function setLayout(i) {
  if (!layoutNodes.length) return;
  layoutIdx = (i + layoutNodes.length) % layoutNodes.length;
  layoutNodes.forEach((n, j) => { n.visible = j === layoutIdx; });
  const n = layoutNodes[layoutIdx];
  const text = `Layout ${n.name.replace('Layout', '')}: ${n.userData.label ?? ''}`;
  layoutBtn.textContent = `${text}  (L to switch)`;
  layoutLabel.set(text);
}
layoutBtn.addEventListener('click', () => setLayout(layoutIdx + 1));
window.addEventListener('keydown', (e) => { if (e.key === 'l' || e.key === 'L') setLayout(layoutIdx + 1); });

function makeLabel() {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.16, 0.02),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
  );
  mesh.position.set(0, 0.05, 0.02);   // just above the left controller
  mesh.rotation.x = -Math.PI / 4;
  return {
    mesh,
    set(text) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = '28px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);
      tex.needsUpdate = true;
    },
  };
}

// ---- model ----
// Quest 1 is weak: swap PBR/transmission materials for cheap Lambert / basic ones.
new GLTFLoader().load('./house.glb', (gltf) => {
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    if (src.transparent || src.name.includes('Glass')) {
      o.material = new THREE.MeshBasicMaterial({
        color: 0x9fd0ff, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
      });
      o.renderOrder = 1;
    } else {
      o.material = new THREE.MeshLambertMaterial({ color: src.color, side: THREE.DoubleSide });
    }
  });
  scene.add(gltf.scene);
  layoutNodes = LAYOUTS.map((n) => gltf.scene.getObjectByName(n)).filter(Boolean);
  if (layoutNodes.length) {
    layoutBtn.style.display = '';
    const q = new URLSearchParams(location.search).get('layout');
    setLayout(Math.max(0, LAYOUTS.indexOf(`Layout${q ?? 'A'}`)));
  }
  status.textContent = navigator.xr ? 'Ready: press Enter VR' : 'Ready (no WebXR in this browser)';
}, undefined, (err) => {
  status.textContent = 'Failed to load model';
  console.error(err);
});

// ---- entering / leaving VR ----
let desktopCam = null;
renderer.xr.addEventListener('sessionstart', () => {
  desktopCam = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
  controls.enabled = false;
  rig.position.copy(SPAWN);
  rig.rotation.set(0, 0, 0);
  status.style.display = 'none';
});
renderer.xr.addEventListener('sessionend', () => {
  rig.position.set(0, 0, 0);
  rig.rotation.set(0, 0, 0);
  camera.position.copy(desktopCam.pos);
  camera.quaternion.copy(desktopCam.quat);
  controls.enabled = true;
  status.style.display = '';
});

// ---- locomotion: left stick = move (head-relative), right stick = snap turn ----
const clock = new THREE.Clock();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const headPos = new THREE.Vector3();
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
  const xrCam = renderer.xr.getCamera();
  for (const src of session.inputSources) {
    if (!src.gamepad) continue;
    // A (right) / X (left) = xr-standard button 4: switch layout on press
    const pressed = !!src.gamepad.buttons[4]?.pressed;
    if (pressed && !buttonWasDown[src.handedness]) setLayout(layoutIdx + 1);
    buttonWasDown[src.handedness] = pressed;
    const { x, y } = stick(src.gamepad);
    if (src.handedness === 'left' && (x || y)) {
      xrCam.getWorldDirection(fwd);
      fwd.y = 0; fwd.normalize();
      right.crossVectors(fwd, THREE.Object3D.DEFAULT_UP).normalize();
      rig.position.addScaledVector(fwd, -y * MOVE_SPEED * dt);
      rig.position.addScaledVector(right, x * MOVE_SPEED * dt);
    } else if (src.handedness === 'right') {
      if (snapReady && Math.abs(x) > 0.7) {
        // rotate the rig around the head so the user turns in place
        const angle = -Math.sign(x) * SNAP_ANGLE;
        xrCam.getWorldPosition(headPos);
        rig.position.sub(headPos).applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle).add(headPos);
        rig.rotation.y += angle;
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
  if (!renderer.xr.isPresenting) controls.update();
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
