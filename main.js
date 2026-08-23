import { FilesetResolver, HandLandmarker }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import { createHandTracker } from './pinch.js';
import { createPoseTracker } from './pose.js';
import * as ui from './interaction.js';
import { reset, scramble } from './cube.js';



const W = 640, H = 480;

const video  = document.getElementById('video');
const canvas = document.getElementById('out');
const ctx    = canvas.getContext('2d');
const status = document.getElementById('status');
const cams   = document.getElementById('cams');
const handInfo = document.getElementById('hand');
const note   = document.getElementById('note');

const MIRROR = true;

let stream = null;
let raf = null;

// fps tracking
let frames = 0, lastTick = performance.now(), fps = 0;

let handLandmarker = null;

const tracker = createHandTracker({ swipeEnabled: false }); // shapes replaced it
const poses = createPoseTracker();
let lastMove = '';
let moveFlash = null;   // { at } — brief confirmation on the feed

ctx.textAlign = 'center';
ctx.textBaseline = 'middle';

async function initHands() {
    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: "hand_landmarker.task",
            delegate: "GPU"
        },
        numHands: 2,
        runningMode: "VIDEO"
    });
}



function toScreen(lm) {
  return {
    x: (MIRROR ? 1 - lm.x : lm.x) * W,
    y: lm.y * H
  };
}

async function openCamera(deviceId) {
  // release any previous claim before requesting a new one
  stop();

  const video_ = deviceId
    ? { deviceId: { exact: deviceId }, width: W, height: H, frameRate: 30 }
    : { width: W, height: H, frameRate: 30 };

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: video_ });
  } catch (err) {
    status.textContent = `failed: ${err.name} — ${err.message}`;
    console.error(err);
    return;
  }

  video.srcObject = stream;
  await video.play();

  await refreshDeviceList();
  loop();
}

async function refreshDeviceList() {
  // labels are blank until permission has been granted at least once,
  // which is why this runs after getUserMedia rather than before
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs  = devices.filter(d => d.kind === 'videoinput');

  const active = stream?.getVideoTracks()[0]?.getSettings().deviceId;

  cams.innerHTML = '';
  inputs.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `camera ${i + 1}`;
    if (d.deviceId === active) opt.selected = true;
    cams.appendChild(opt);
  });
}

function loop() {
  raf = requestAnimationFrame(loop);

  // readyState < 2 means no frame is available yet
  if (video.readyState < 2) return;

  ctx.save();

  if (MIRROR) { ctx.translate(W, 0); ctx.scale(-1, 1); }

  ctx.drawImage(video, 0, 0, W, H);
  ctx.restore();

  if (handLandmarker) {
    const t0 = performance.now();

    const results = handLandmarker.detectForVideo(video, performance.now());

    const t1 = performance.now();
    if (frames % 30 === 0) console.log('detect ms:', (t1 - t0).toFixed(1));

    const hands = results?.landmarks ?? [];
    for (const hand of hands) drawHand(hand);

    // one hand drives the pointer; the first one detected wins. worldLandmarks
    // are the metric 3D version of the same hand — see pose.js
    driveGestures(hands[0] ?? null,
                  results?.handednesses?.[0]?.[0],
                  results?.worldLandmarks?.[0] ?? null);
  }


  frames++;
  const now = performance.now();
  if (now - lastTick >= 1000) {
    fps = frames;
    frames = 0;
    lastTick = now;
    

    const s = stream.getVideoTracks()[0].getSettings();
    status.textContent =
      `${s.width}×${s.height} · source ${s.frameRate ?? '?'}fps · drawing ${fps}fps`;
  }
}

// A hand can't comfortably reach the corners of the frame, so a region in the
// middle of the frame is stretched to cover the whole cube canvas. Sensitivity
// shrinks that region: the smaller it is, the further the pointer travels for
// the same hand movement. 1.0 = the middle ~70%.
const REACH_BASE = { hx: 0.35, hy: 0.38 }; // half-extents at sensitivity 1
const REACH = { x0: 0, y0: 0, x1: 1, y1: 1 };
const clamp01 = v => Math.min(1, Math.max(0, v));

const modeInput = document.getElementById('pinch-mode');
modeInput.addEventListener('change', () => ui.setPinchMode(modeInput.value));
ui.setPinchMode(modeInput.value);

const sensInput = document.getElementById('sens');
const sensLabel = document.getElementById('sens-value');

function setSensitivity(value) {
  const s = Math.min(3, Math.max(0.5, Number(value) || 1));
  const hx = REACH_BASE.hx / s, hy = REACH_BASE.hy / s;
  REACH.x0 = 0.5 - hx; REACH.x1 = 0.5 + hx;
  REACH.y0 = 0.5 - hy; REACH.y1 = 0.5 + hy;
  sensLabel.textContent = `${s.toFixed(1)}×`;
  try { localStorage.setItem('sensitivity', s); } catch {}
}

let stored = null;
try { stored = localStorage.getItem('sensitivity'); } catch {}
sensInput.value = stored ?? 1.6;
setSensitivity(sensInput.value);
sensInput.addEventListener('input', () => setSensitivity(sensInput.value));

function toStage(p) {
  return {
    x: clamp01((p.x / W - REACH.x0) / (REACH.x1 - REACH.x0)) * W,
    y: clamp01((p.y / H - REACH.y0) / (REACH.y1 - REACH.y0)) * H,
  };
}

// Gesture → cube. Shapes, not motion: where the hand is doesn't matter.
//   1-3 fingers, pointing right/left  moves that row right / left
//   1-3 fingers, pointing up/down     moves that column up / down
//   hold the shape ~450ms             commits the move
//   pinch and move                    rotates or moves the whole cube
function driveGestures(lms, handedness, world) {
  const g = tracker.update(lms, toScreen);

  if (!g.visible) {
    poses.reset();   // a hand coming back shouldn't inherit a half-held shape
    ui.orbitEnd();
    ui.hideCursor();
    ui.hideBands();
    handInfo.textContent = 'no hand';
    return;
  }

  const p = toStage({ x: g.palmX, y: g.palmY });   // palm, in canvas pixels
  ui.showCursor(p.x, p.y, g.pinching ? 'pressed' : g.closing ? 'arming' : 'idle');

  // pinch = global rotate/move, so you can bring the other faces round. It has
  // priority: a shape made while pinching must not fire a turn.
  if (g.pressed)       { ui.hideBands(); ui.orbitStart(p.x, p.y); }
  else if (g.pinching) ui.orbitDrag(p.x, p.y);
  else if (g.released) ui.orbitEnd();

  // hand shape = which slab, and which way it turns
  const shape = poses.update(lms, toScreen, { inhibit: g.pinching, world });

  if (shape.valid) {
    const intent = ui.poseIntent(shape);
    ui.showBands(intent.zone, intent.only);
  } else if (!g.pinching) {
    ui.hideBands();
  }

  if (shape.fired) {
    const move = ui.poseTurn(shape.fired);
    lastMove = `${shapeLabel(shape.fired)}` +
               ` → ${move.axis}${move.layer >= 0 ? '+' : ''}${move.layer}`;
    moveFlash = { at: performance.now() };
  }

  drawPose(g, shape);

  // live readout: without this there's no way to see what shape the model
  // thinks you're making, or how close the dwell is to firing
  handInfo.textContent = [
    g.pinching
      ? `● ${ui.pinchMode() === 'move' ? 'moving cube' : 'rotating view'}`
      : `${shape.count} finger${shape.count === 1 ? '' : 's'} ` +
        `${shape.thumb ? `thumb ${shape.thumb}` : shape.direction ?? '—'}` +
        `${shape.valid ? '' : '  (rest)'}`,
    // thumb diagnostics: gap is how extended it reads, lean which side
    `thumb ${shape.thumbGap.toFixed(2)}/${poses.config.thumbOut}` +
    ` lean ${shape.lean >= 0 ? '+' : ''}${shape.lean.toFixed(2)}`,
    shape.charge > 0 ? `holding ${Math.round(shape.charge * 100)}%` : '',
    lastMove ? `last ${lastMove}` : '',
  ].filter(Boolean).join('   ');
}

// Feed overlay for the shape: finger count, pointing direction, and a ring
// that fills over the dwell. save/restore around every font change — it is
// context state, and the landmark labels inherit whatever is left set.
const ARROW = { up: '↑', down: '↓', left: '←', right: '→' };

// what the shape reads as: "2→" for a row/column push, "⟳" for a face turn
// (no count there — the thumb is only two controls)
const shapeLabel = ({ count, direction, thumb }) =>
  thumb ? (thumb === 'right' ? '⟳' : '⟲') : `${count}${ARROW[direction] ?? '·'}`;

function drawPose(g, shape) {
  const closed = g.pinching;

  ctx.strokeStyle = closed ? '#fff' : shape.valid ? '#0ff' : '#666';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(g.palmX, g.palmY, 10, 0, Math.PI * 2);
  ctx.stroke();

  // dwell ring: fills clockwise, green the moment it completes
  if (shape.charge > 0) {
    ctx.strokeStyle = shape.charge >= 1 ? '#0f0' : '#ff0';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(g.palmX, g.palmY, 20, -Math.PI / 2,
            -Math.PI / 2 + shape.charge * Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  if (shape.valid) {
    ctx.fillStyle = shape.thumb ? '#ff0' : '#0ff';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText(shapeLabel(shape), g.palmX, g.palmY - 36);
  }

  if (moveFlash && performance.now() - moveFlash.at < 400) {
    ctx.fillStyle = '#0f0';
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.fillText('✓', W / 2, H / 2);
  }
  ctx.restore();
}

//0                    wrist

//1  2  3  4           thumb    (base → tip)
//5  6  7  8           index
//9  10 11 12          middle
//13 14 15 16          ring
//17 18 19 20          pinky
const FINGERS = [
  { name: 'thumb',  color: '#0f0' },
  { name: 'index',  color: '#00f' },
  { name: 'middle', color: '#ff0' },
  { name: 'ring',   color: '#0ff' },
  { name: 'pinky',  color: '#f0f' },
];

function drawHand(lms) {
    ctx.font = '12px system-ui, sans-serif'; // don't inherit whatever was set

    FINGERS.forEach((f, n) => {
        ctx.fillStyle = f.color;
        

        for (let j = 0; j < 4; j++) {
            const p = toScreen(lms[1 + n * 4 + j]);
            ctx.beginPath();
            //ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            ctx.fill();

            
            ctx.fillText(1 + n * 4 + j, p.x, p.y);
        }
    });

    // wrist
    ctx.fillStyle = '#fff';
    const w = toScreen(lms[0]);
    ctx.beginPath();
    //ctx.arc(w.x, w.y, 5, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillText(0, w.x, w.y);
}

function stop() {
  if (raf) { cancelAnimationFrame(raf); raf = null; }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

cams.addEventListener('change', () => openCamera(cams.value));

// Both are queued behind any turn still animating, so neither can fire
// mid-rotation. A drag in progress is dropped first.
function button(id, handler) {
  const el = document.getElementById(id);
  if (!el) { console.warn(`no #${id} in the page`); return; }
  el.addEventListener('click', () => {
    ui.pointerUp();
    ui.clearHover();
    // reset on an already-solved cube looks like nothing happened, so say so.
    // Its own element: the gesture readout overwrites #hand every frame.
    note.textContent = handler();
  });
}

button('reset', () => { reset(); return 'cube reset'; });
button('scramble', () => `scrambled: ${scramble().join(' ')}`);


// release the hardware claim on navigate-away
window.addEventListener('pagehide', stop);

openCamera();
initHands();