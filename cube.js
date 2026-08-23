import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('rubik');
const W = canvas.width, H = canvas.height;

// white on top, and the four sides run red → green → blue → orange going
// clockwise seen from above (R → B → L → F)
const FACE_COLORS = {
  px: 0xc41e3a, // right  red
  nx: 0x0051ba, // left   blue
  py: 0xffffff, // up     white
  ny: 0xffd500, // down   yellow
  pz: 0xff5800, // front  orange
  nz: 0x009e60, // back   green
};
const INNER = 0x151515; // faces that point into the cube body

const SIZE = 0.94; // < 1 leaves the gap that makes the sticker grid readable

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(W, H, false); // false: don't touch the CSS size

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
camera.position.set(4.5, 4, 5.5);

scene.add(new THREE.AmbientLight(0xffffff, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(5, 8, 6);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(-6, -3, -5);
scene.add(fill);

const geometry = new THREE.BoxGeometry(SIZE, SIZE, SIZE);

// BoxGeometry material order is [+x, -x, +y, -y, +z, -z]
function materialsFor(x, y, z) {
  return [
    x ===  1 ? FACE_COLORS.px : INNER,
    x === -1 ? FACE_COLORS.nx : INNER,
    y ===  1 ? FACE_COLORS.py : INNER,
    y === -1 ? FACE_COLORS.ny : INNER,
    z ===  1 ? FACE_COLORS.pz : INNER,
    z === -1 ? FACE_COLORS.nz : INNER,
  ].map(color => new THREE.MeshLambertMaterial({ color }));
}

// 26 cubies: {-1,0,1}³ minus the invisible core
export const cubies = [];
const home = new Map(); // cubie → solved position, for reset()
for (let x = -1; x <= 1; x++) {
  for (let y = -1; y <= 1; y++) {
    for (let z = -1; z <= 1; z++) {
      if (x === 0 && y === 0 && z === 0) continue;
      const cubie = new THREE.Mesh(geometry, materialsFor(x, y, z));
      cubie.position.set(x, y, z);
      scene.add(cubie);
      cubies.push(cubie);
      home.set(cubie, cubie.position.clone());
    }
  }
}

const controls = new OrbitControls(camera, canvas);
// left drag is ours (drag a sticker to turn it), so pan takes the other buttons
controls.enablePan = true;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.PAN,
};
controls.minDistance = 4;
controls.maxDistance = 14;
controls.target.set(0, 0, 0);
controls.update();

// static cube: render on demand, so it doesn't compete with the detect loop
export function render() {
  renderer.render(scene, camera);
}
controls.addEventListener('change', render);
render();

export { scene, camera, renderer, controls };


// ─── layer rotation ──────────────────────────────────────────────────────────
//
// Rotating nine cubies individually compounds their orientations wrongly, so
// every turn goes through one pivot at the cube centre:
//
//   1. pivot.attach(cubie)  — keeps the cubie's world transform
//   2. animate pivot.rotation[axis] to ±90°
//   3. scene.attach(cubie)  — re-parents, baking the rotation in
//
// The pivot is reset to identity after each turn, so it never accumulates.

const pivot = new THREE.Group();
scene.add(pivot);

// dir is the sign that makes a *clockwise-viewed-from-outside* quarter turn:
// negative for faces on the positive side of an axis, positive for the others.
// Slice moves follow the face they run parallel to (M→L, E→D, S→F).
const MOVES = {
  R: { axis: 'x', layer:  1, dir: -1 },
  L: { axis: 'x', layer: -1, dir:  1 },
  U: { axis: 'y', layer:  1, dir: -1 },
  D: { axis: 'y', layer: -1, dir:  1 },
  F: { axis: 'z', layer:  1, dir: -1 },
  B: { axis: 'z', layer: -1, dir:  1 },
  M: { axis: 'x', layer:  0, dir:  1 },
  E: { axis: 'y', layer:  0, dir:  1 },
  S: { axis: 'z', layer:  0, dir: -1 },
};

export const MOVE_NAMES = Object.keys(MOVES);

// "R" | "R'" | "R2" → { axis, layer, dir, quarters }
export function parseMove(notation) {
  const m = /^([RLUDFBMES])(['2]?)$/.exec(String(notation).trim());
  if (!m) throw new Error(`bad move: ${notation}`);
  const move = MOVES[m[1]];
  const quarters = m[2] === '2' ? 2 : 1;
  return { ...move, dir: m[2] === "'" ? -move.dir : move.dir, quarters };
}

// positions drift by float epsilon, so always round before comparing
export function layerCubies(axis, layer) {
  return cubies.filter(c => Math.round(c.position[axis]) === layer);
}

// cubie transforms are always axis-aligned, so rounding is a safe way to keep
// float error from accumulating over thousands of turns
function snap(cubie) {
  cubie.position.round();
  const m = new THREE.Matrix4().makeRotationFromQuaternion(cubie.quaternion);
  m.fromArray(m.elements.map(Math.round));
  cubie.quaternion.setFromRotationMatrix(m);
}

const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

let turning = false;
export const isTurning = () => turning;

function runTurn(axis, layer, quarters, duration) {
  const angle = quarters * Math.PI / 2;
  const group = layerCubies(axis, layer);

  const finish = () => {
    pivot.rotation[axis] = angle;
    pivot.updateMatrixWorld(true);
    for (const c of group) { scene.attach(c); snap(c); }
    pivot.rotation.set(0, 0, 0);
    turning = false;
    render();
  };

  turning = true;
  pivot.rotation.set(0, 0, 0);
  for (const c of group) pivot.attach(c);

  if (duration <= 0) { finish(); return Promise.resolve(); }

  return new Promise(resolve => {
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / duration);
      if (t < 1) {
        pivot.rotation[axis] = angle * easeInOut(t);
        render();
        requestAnimationFrame(step);
      } else {
        finish();
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

// Turns are serialised: overlapping animations on intersecting layers would
// attach the same cubie to the pivot twice. Awaiting is optional.
let queue = Promise.resolve();

// quarters is signed: +1 is a positive (right-hand) rotation about +axis,
// which is what the drag math produces. duration 0 applies it instantly.
export function turnLayer(axis, layer, quarters = 1, { duration = 200 } = {}) {
  queue = queue.then(() => runTurn(axis, layer, quarters, duration));
  return queue;
}

export function turn(notation, opts) {
  const { axis, layer, dir, quarters } = parseMove(notation);
  return turnLayer(axis, layer, dir * quarters, opts);
}

// turnAll("R U R' U'") — accepts a string or an array of moves
export function turnAll(sequence, opts) {
  const moves = Array.isArray(sequence) ? sequence : sequence.trim().split(/\s+/);
  let last = queue;
  for (const m of moves) if (m) last = turn(m, opts);
  return last;
}

export function scramble(count = 20, opts = { duration: 90 }) {
  const moves = [];
  let prevAxis = null;
  while (moves.length < count) {
    const name = MOVE_NAMES[Math.floor(Math.random() * 6)]; // faces only
    const { axis } = MOVES[name];
    if (axis === prevAxis) continue; // two turns of the same axis in a row are redundant
    prevAxis = axis;
    moves.push(name + ["", "'", "2"][Math.floor(Math.random() * 3)]);
  }
  turnAll(moves, opts);
  return moves;
}

// back to solved, no animation
export function reset() {
  queue = queue.then(() => {
    for (const c of cubies) {
      scene.attach(c);
      c.position.copy(home.get(c));
      c.quaternion.identity();
    }
    render();
  });
  return queue;
}

// so turns can be driven from the devtools console while there's no UI yet:
//   cube.turnAll("R U R' U'")   cube.scramble()   cube.reset()
window.cube = { turn, turnAll, scramble, reset, parseMove, layerCubies, isTurning, cubies };
