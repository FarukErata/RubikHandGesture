import { FilesetResolver, HandLandmarker }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";



const W = 640, H = 480;

const video  = document.getElementById('video');
const canvas = document.getElementById('out');
const ctx    = canvas.getContext('2d');
const status = document.getElementById('status');
const cams   = document.getElementById('cams');
const handInfo = document.getElementById('hand');

const MIRROR = true;

let stream = null;
let raf = null;

// fps tracking
let frames = 0, lastTick = performance.now(), fps = 0;

let handLandmarker = null;

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

    if (results && results.landmarks.length > 0) {
      handInfo.textContent = results.handednesses
        .map(h => `${h[0].categoryName} ${(h[0].score * 100).toFixed(0)}%`)
        .join('  ');

      for (const hand of results.landmarks) {
        drawHand(hand);
      }
    } else {
      handInfo.textContent = 'no hand';
    }
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


// release the hardware claim on navigate-away
window.addEventListener('pagehide', stop);

openCamera();
initHands();