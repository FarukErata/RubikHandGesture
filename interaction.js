import * as THREE from 'three';
import { scene, camera, controls, cubies, render, turnLayer, isTurning } from './cube.js';

// One pointer abstraction, two drivers: real mouse events and the pinch
// tracker both come through pointerDown/Move/Up in cube-canvas pixels.
// Debugging the drag→turn math with a mouse is much easier than with a hand.

const canvas = document.getElementById('rubik');
const cursor = document.getElementById('cursor');
const W = canvas.width, H = canvas.height;

const DRAG_COMMIT = 55;   // px of drag before a turn is committed — a hand
                          // covers far more ground per frame than a mouse
const DRAG_DECISIVE = 1.3; // how much the winning drag axis must beat the other
const AXES = { x: new THREE.Vector3(1, 0, 0),
               y: new THREE.Vector3(0, 1, 0),
               z: new THREE.Vector3(0, 0, 1) };

const raycaster = new THREE.Raycaster();
let drag = null; // { cubie, normal, hit, start, committed } | { orbit: true, last }

function pick(x, y) {
  raycaster.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), camera);
  const [hit] = raycaster.intersectObjects(cubies, false);
  if (!hit) return null;
  // face normal in world space, snapped to the axis it must be parallel to
  const normal = hit.face.normal.clone()
    .transformDirection(hit.object.matrixWorld)
    .round();
  return { cubie: hit.object, normal, point: hit.point };
}

// where a world-space direction at `point` goes on screen (px, y down)
function screenDir(point, dir) {
  const a = point.clone().project(camera);
  const b = point.clone().addScaledVector(dir, 0.5).project(camera);
  return new THREE.Vector2((b.x - a.x) * W / 2, -(b.y - a.y) * H / 2);
}

// Which layer does dragging this face by `dv` turn, and which way?
function resolveTurn({ cubie, normal, point }, dv) {
  // the two in-face directions: every axis that isn't the face normal
  const candidates = ['x', 'y', 'z']
    .filter(name => Math.abs(normal[name]) < 0.5)
    .map(name => ({ name, dot: screenDir(point, AXES[name]).dot(dv) }))
    .sort((a, b) => Math.abs(b.dot) - Math.abs(a.dot));

  const [best, other] = candidates;
  if (!best) return null;
  // a drag running diagonally across the sticker could mean either turn —
  // stay uncommitted and let it resolve rather than guessing
  if (other && Math.abs(best.dot) < Math.abs(other.dot) * DRAG_DECISIVE) return null;

  // world-space direction the grabbed point should travel
  const move = AXES[best.name].clone().multiplyScalar(Math.sign(best.dot));
  // a positive rotation about (normal × move) moves the point along `move`
  const spin = new THREE.Vector3().crossVectors(normal, move).round();

  const axis = ['x', 'y', 'z'].find(n => Math.abs(spin[n]) > 0.5);
  if (!axis) return null;
  return {
    axis,
    layer: Math.round(cubie.position[axis]),
    quarters: Math.sign(spin[axis]),
  };
}

// ─── hover projection ────────────────────────────────────────────────────────
//
// Where the pointer ray meets the cube, drawn as a highlight laid on that
// sticker. This is the feedback that makes a pinch land where you meant it.

const SIZE = 0.94; // must match the cubie size in cube.js
const highlight = new THREE.Mesh(
  new THREE.PlaneGeometry(SIZE, SIZE),
  new THREE.MeshBasicMaterial({
    color: 0x00ffff, transparent: true, opacity: 0.35,
    depthWrite: false, side: THREE.DoubleSide,
  })
);
highlight.visible = false;
highlight.renderOrder = 1;
scene.add(highlight);

const FORWARD = new THREE.Vector3(0, 0, 1);
let hoverKey = null;

/** Project the pointer onto the cube. Returns the hovered face, or null. */
export function hover(x, y) {
  const target = drag && !drag.orbit ? drag : pick(x, y);
  if (!target) { clearHover(); return null; }

  const { cubie, normal } = target;
  const key = `${cubie.id}:${normal.x},${normal.y},${normal.z}`;
  if (key === hoverKey) return target;   // nothing moved: skip the redraw
  hoverKey = key;

  highlight.position.copy(cubie.getWorldPosition(new THREE.Vector3()))
    .addScaledVector(normal, SIZE / 2 + 0.006); // lift off the face to avoid z-fighting
  highlight.quaternion.setFromUnitVectors(FORWARD, normal);
  highlight.visible = true;
  render();
  return target;
}

export function clearHover() {
  if (!highlight.visible) return;
  highlight.visible = false;
  hoverKey = null;
  render();
}

// ─── camera ──────────────────────────────────────────────────────────────────

const spherical = new THREE.Spherical();
const PHI_LIMIT = 0.15; // keep off the poles, where azimuth becomes meaningless

function orbitBy(dTheta, dPhi) {
  spherical.setFromVector3(camera.position.clone().sub(controls.target));
  spherical.theta -= dTheta;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi - dPhi, PHI_LIMIT, Math.PI - PHI_LIMIT);
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
  camera.lookAt(controls.target);
  controls.update();
  // bands are view-relative, so a rotation re-aims them
  if (lastZone && Object.values(slabs).some(s => s.visible)) {
    slabKey = null;
    showBands(lastZone, lastOnly);
  }
  render();
}

// Slide the cube across the view, camera-relative: target and camera move
// together, so the viewing angle is unchanged. Takes raw hand deltas — the
// camera shifts opposite to the hand, which makes the cube follow it.
function panBy(hx, hy) {
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const shift = right.multiplyScalar(-hx).add(up.multiplyScalar(hy));
  camera.position.add(shift);
  controls.target.add(shift);
  controls.update();
  render();
}

// Global manipulation, for looking at the other faces. Needs no precision, so
// the pinch drives it: hold and move. Which of the two it does is a mode, since
// there's no reliable second hand gesture to distinguish them.
let dragging = null;
let mode = 'rotate';   // 'rotate' | 'move'

export function setPinchMode(next) { mode = next; }
export const pinchMode = () => mode;

export function orbitStart(x, y) { dragging = { x, y }; }

export function orbitDrag(x, y) {
  if (!dragging) return;
  const hx = x - dragging.x, hy = y - dragging.y;
  // negated for rotate too: the cube follows the hand, rather than the camera
  // chasing it around the other way
  if (mode === 'rotate') orbitBy(-hx * 0.008, -hy * 0.008);
  else                   panBy(hx * 0.012, hy * 0.012);
  dragging = { x, y };
}

export function orbitEnd() { dragging = null; }

export const isOrbiting = () => dragging !== null;

// ─── bands: coarse, screen-relative layer selection ──────────────────────────
//
// No raycasting. The hand's zone picks a whole slab of the cube, and a swipe
// turns it. Rows and columns are defined by what the camera sees, so "swipe
// right on the top row" always does what it looks like, whatever the view.

/** the world axis nearest a view direction, with the sign it points in */
function nearestAxis(v) {
  const axis = Math.abs(v.x) > Math.abs(v.y)
    ? (Math.abs(v.x) > Math.abs(v.z) ? 'x' : 'z')
    : (Math.abs(v.y) > Math.abs(v.z) ? 'y' : 'z');
  return { axis, sign: Math.sign(v[axis]) || 1 };
}

const viewAxes = () => ({
  right: nearestAxis(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)),
  up:    nearestAxis(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)),
  // points out of the screen, toward the viewer
  face:  nearestAxis(camera.position.clone().sub(controls.target)),
});

/**
 * Which slab a zone selects.
 * @param orientation 'row' (stacked vertically), 'column', or 'face' (stacked
 *   front to back, along the direction you're looking)
 * @param zone -1 | 0 | 1 — left/middle/right, bottom/middle/top, or back/
 *   middle/front
 */
export function bandFor(orientation, zone) {
  const view = viewAxes();
  const { axis, sign } = orientation === 'row' ? view.up
                       : orientation === 'column' ? view.right
                       : view.face;
  return { axis, layer: zone * sign };
}

/**
 * Turn the slab the hand is over. Horizontal swipes turn the row the hand is
 * in, vertical swipes turn the column.
 */
export function swipeTurn(direction, zone) {
  const horizontal = direction === 'left' || direction === 'right';
  const view = viewAxes();

  // A positive rotation about the screen-up axis carries the front face to the
  // right; about the screen-right axis it carries it down. Hence the signs.
  const { axis, sign } = horizontal ? view.up : view.right;
  const band = horizontal ? zone.row : zone.col;
  const quarters = horizontal
    ? (direction === 'right' ? sign : -sign)
    : (direction === 'up' ? -sign : sign);

  turnLayer(axis, band * sign, quarters, { duration: 180 });
  return { axis, layer: band * sign, quarters };
}

// ── poses ────────────────────────────────────────────────────────────────────
//
// A held shape names a slab and a direction. Fingers pointing up or down means
// a row; left or right means a column. Finger count picks which one: rows are
// counted top→bottom, columns left→right, so 2 is always the middle slice.

/**
 * The fingers point the way the slab should travel, so the orientation follows
 * from the direction: a sideways push can only mean a row, a vertical one a
 * column. Nothing to memorise beyond "it goes where I point".
 *
 * @returns { zone, only, direction } — what this shape would do
 */
export function poseIntent({ count, direction, thumb }) {
  // A thumb out to the side turns the face you're looking at, and that's all
  // it does: two controls, clockwise and anticlockwise. Finger count doesn't
  // select a depth layer — the far layers are reached by rotating the cube.
  if (thumb) {
    return { zone: { row: 0, col: 0, face: 1 }, only: 'face', thumb };
  }
  const isRow = direction === 'left' || direction === 'right';
  return isRow
    ? { zone: { row: 2 - count, col: 0 }, only: 'row', direction }
    : { zone: { row: 0, col: count - 2 }, only: 'column', direction };
}

/**
 * Turn the layer facing the camera. Clockwise as seen from here is a negative
 * rotation about the axis pointing back at us — the same rule the face turns in
 * cube.js follow.
 */
function faceTurn(thumb, band) {
  const { axis, sign } = viewAxes().face;
  const layer = band * sign;
  const quarters = (thumb === 'right' ? -1 : 1) * sign;
  turnLayer(axis, layer, quarters, { duration: 180 });
  return { axis, layer, quarters };
}

export function poseTurn(pose) {
  const intent = poseIntent(pose);
  return intent.only === 'face'
    ? faceTurn(intent.thumb, intent.zone.face)
    : swipeTurn(intent.direction, intent.zone);
}

// ── band preview ─────────────────────────────────────────────────────────────
// Both candidate slabs are shown, since which one turns depends on whether the
// swipe is horizontal or vertical: cyan is the row, magenta the column.

function makeSlab(color) {
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false })
  );
  slab.visible = false;
  scene.add(slab);
  return slab;
}

const slabs = {
  row: makeSlab(0x00ffff),   // cyan
  col: makeSlab(0xff00ff),   // magenta
  face: makeSlab(0xffff00),  // yellow
};
const SPAN = 3.1, THICK = 1.05;
let slabKey = null, lastZone = null, lastOnly = null;

/**
 * @param zone { row, col } each -1 | 0 | 1
 * @param only 'row' | 'column' to preview just one slab, when the gesture
 *   already says which orientation it will turn
 */
export function showBands(zone, only = null) {
  lastZone = zone;
  lastOnly = only;
  const key = `${zone.row},${zone.col},${zone.face ?? 0},${only}`;
  if (key === slabKey) return;
  slabKey = key;

  for (const [orientation, slab, band] of [['row', slabs.row, zone.row],
                                           ['column', slabs.col, zone.col],
                                           ['face', slabs.face, zone.face ?? 0]]) {
    if (only && only !== orientation) { slab.visible = false; continue; }
    const { axis, layer } = bandFor(orientation, band);
    slab.scale.set(axis === 'x' ? THICK : SPAN,
                   axis === 'y' ? THICK : SPAN,
                   axis === 'z' ? THICK : SPAN);
    slab.position.set(0, 0, 0);
    slab.position[axis] = layer;
    slab.visible = true;
  }
  render();
}

export function hideBands() {
  if (!Object.values(slabs).some(s => s.visible)) return;
  for (const slab of Object.values(slabs)) slab.visible = false;
  slabKey = null;
  render();
}

// ─── pointer ─────────────────────────────────────────────────────────────────

/**
 * @param origin where drag distance is measured from, if that differs from the
 *   picked point — a pinch grabs where the hand was *aiming*, but must measure
 *   travel from where the hand actually is, or the finger-closing motion is
 *   counted as drag and skews the direction.
 * @returns true if the press landed on the cube (caller may suppress orbit)
 */
export function pointerDown(x, y, { allowOrbit = true, origin } = {}) {
  if (isTurning()) return false;       // don't grab a layer mid-animation
  const target = pick(x, y);
  if (target) {
    const from = origin ?? { x, y };
    drag = { ...target, start: new THREE.Vector2(from.x, from.y), committed: false };
    return true;
  }
  drag = allowOrbit ? { orbit: true, last: new THREE.Vector2(x, y) } : null;
  return false;
}

export function pointerMove(x, y) {
  if (!drag) return;

  if (drag.orbit) {
    // negated: dragging pulls the cube with the hand, rather than pushing the
    // camera around it
    orbitBy((drag.last.x - x) * 0.008, (drag.last.y - y) * 0.008);
    drag.last.set(x, y);
    return;
  }
  if (drag.committed) return;          // one turn per grab

  const dv = new THREE.Vector2(x - drag.start.x, y - drag.start.y);
  if (dv.length() < DRAG_COMMIT) return;

  const move = resolveTurn(drag, dv);
  if (!move) return;              // ambiguous so far — wait, don't guess
  drag.committed = true;
  turnLayer(move.axis, move.layer, move.quarters, { duration: 160 });
}

export function pointerUp() { drag = null; }

export const isDragging = () => drag !== null;

// ─── cursor overlay ──────────────────────────────────────────────────────────

/** state: 'idle' | 'arming' (pinch not held long enough yet) | 'pressed' */
export function showCursor(x, y, state = 'idle') {
  const scale = canvas.getBoundingClientRect().width / W; // canvas may be CSS-scaled
  cursor.style.transform = `translate(${x * scale}px, ${y * scale}px)`;
  cursor.style.opacity = 1;
  cursor.classList.toggle('on', state === 'pressed');
  cursor.classList.toggle('arming', state === 'arming');
}

export function hideCursor() {
  cursor.style.opacity = 0;
  cursor.classList.remove('on', 'arming');
}

// ─── mouse driver ────────────────────────────────────────────────────────────
//
// A press on the cube runs our drag→turn logic (OrbitControls is muted for the
// duration); a press on the background is left to OrbitControls entirely.

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (W / r.width),
           y: (e.clientY - r.top) * (H / r.height) };
}

canvas.addEventListener('pointerdown', e => {
  const { x, y } = toCanvas(e);
  if (pointerDown(x, y, { allowOrbit: false })) {
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  }
});

canvas.addEventListener('pointermove', e => {
  const { x, y } = toCanvas(e);
  if (drag) pointerMove(x, y);
  if (!drag || !drag.orbit) hover(x, y);
});

canvas.addEventListener('pointerleave', clearHover);

for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, () => {
    pointerUp();
    controls.enabled = true;
  });
}
