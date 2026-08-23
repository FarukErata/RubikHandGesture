// Hand shape → move. No motion involved: you hold a shape, a dwell timer
// fills, and the move fires. Nothing here depends on speed or precision.
//
//   where they point   the way the slab travels — and so, implicitly, whether
//                      it's a row or a column:
//                        right → that row moves right
//                        left  → that row moves left
//                        up    → that column moves up
//                        down  → that column moves down
//   how many fingers   which slab: 1 / 2 / 3, counted top→bottom for rows,
//                      left→right for columns, so 2 is always the middle
//   thumb out sideways the face you're looking at turns instead — right for
//                      clockwise, left for anticlockwise. Two controls, no
//                      layer choice, and the finger count is irrelevant: this
//                      is the one rotation the four directions can't express.
//
// The thumb is otherwise ignored when counting: it moves when the other
// fingers do, so including it would make counts unstable mid-shape.

export const CONFIG = {
  poseHold: 450,     // ms a shape must be held before it fires
  poseCooldown: 250, // ms after firing before anything can fire again
  extendMargin: 1.12, // tip must be this much further from the wrist than the
                      // knuckle joint to count as extended
  dirRatio: 1.2,      // dominant pointing axis must beat the other by this
  // thumb tip to index knuckle, over the palm span: a tucked thumb sits on the
  // palm, an extended one is most of a palm-width away
  thumbOut: 0.7,
  // how far sideways the thumb must lean, as a fraction of the palm span,
  // before its side counts. Not a dominance ratio: a thumb held diagonally
  // still has an unambiguous side, and demanding it beat the vertical
  // component means the gesture only works with the hand held one way.
  thumbSide: 0.18,
};

// index, middle, ring, pinky — PIP joint and tip. The thumb isn't counted.
const FINGERS = [[6, 8], [10, 12], [14, 16], [18, 20]];
const WRIST = 0, MCP_MIDDLE = 9;
const THUMB_MCP = 2, THUMB_TIP = 4, MCP_INDEX = 5;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// 3D, for MediaPipe's worldLandmarks: metric coordinates that don't foreshorten
// when the hand turns, which 2D screen distances badly do
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function createPoseTracker(config = {}) {
  const cfg = { ...CONFIG, ...config };

  let key = null, keySince = 0;  // the shape currently being held
  let spent = null;              // shape already fired; must change to re-fire
  let firedAt = -Infinity;

  function idle() {
    key = null; spent = null;
    return { count: 0, direction: null, thumb: null, thumbGap: 0, lean: 0,
             charge: 0, fired: null, valid: false };
  }

  return {
    config: cfg,

    /**
     * @param lms one hand's landmarks, or null
     * @param world the same hand's worldLandmarks, if available: metric 3D, so
     *   shape tests hold however the hand is turned. Screen coordinates are
     *   still what decide pointing direction, since that's about what you see.
     * @param inhibit true while another gesture owns the hand (a pinch), so
     *   shapes made in passing can't fire
     */
    update(lms, toScreen, { inhibit = false, world = null } = {},
           now = performance.now()) {
      if (!lms) return idle();

      const wrist = toScreen(lms[WRIST]);
      const mcp = toScreen(lms[MCP_MIDDLE]);

      // Measure the hand's shape in 3D when we can. In 2D a fist held with the
      // knuckles up foreshortens to nothing and every finger reads as curled.
      const shape = world ?? lms.map(toScreen);
      const metric = world ? dist3 : dist;
      const shapeSpan = Math.max(1e-6, metric(shape[WRIST], shape[MCP_MIDDLE]));

      // count extended fingers: a curled finger's tip falls back toward the
      // wrist, so comparing both distances is scale- and distance-invariant
      let count = 0;
      for (const [pip, tip] of FINGERS) {
        if (metric(shape[tip], shape[WRIST]) >
            metric(shape[pip], shape[WRIST]) * cfg.extendMargin) count++;
      }

      // where the hand points: wrist → middle knuckle, a rigid span
      const vx = mcp.x - wrist.x, vy = mcp.y - wrist.y;
      let direction = null;
      if (Math.abs(vx) > Math.abs(vy) * cfg.dirRatio) direction = vx > 0 ? 'right' : 'left';
      else if (Math.abs(vy) > Math.abs(vx) * cfg.dirRatio) direction = vy > 0 ? 'down' : 'up';

      // Thumb out to the side means "turn the face I'm looking at". Whether
      // it's extended is a 3D question — a thumb pointing at the camera is
      // extended but projects to nothing — while which side it's on is a 2D
      // one, because that's the direction you see it lean.
      const thumbGap = metric(shape[THUMB_TIP], shape[MCP_INDEX]) / shapeSpan;
      const out = thumbGap > cfg.thumbOut;

      const screenSpan = Math.max(1e-6, dist(wrist, mcp));
      const lean = (toScreen(lms[THUMB_TIP]).x - toScreen(lms[THUMB_MCP]).x)
                 / screenSpan;
      const thumb = out && Math.abs(lean) > cfg.thumbSide
        ? (lean > 0 ? 'right' : 'left')
        : null;

      // 1–3 fingers select a slab; 0 (fist) and 4 (open) are deliberate rest
      // shapes, so the hand has somewhere neutral to go between moves.
      //
      // A thumb out is its own gesture and ignores all of that: it doesn't use
      // the count, so gating it on the count only made the face turn fail with
      // a hand held open — the most natural way to stick a thumb out.
      const counted = count >= 1 && count <= 3;
      const valid = !inhibit &&
                    (thumb !== null || (counted && direction !== null));
      // the count is part of the shape only when it selects a slab: a thumb
      // turn is the same move whatever the fingers are doing
      const nextKey = !valid ? null : thumb ? `T${thumb}` : `${count}${direction}`;

      if (nextKey !== key) { key = nextKey; keySince = now; }
      if (!valid) {
        spent = null;
        return { count, direction, thumb, thumbGap, lean,
                 charge: 0, fired: null, valid };
      }

      const held = now - keySince;
      const ready = key !== spent && now - firedAt > cfg.poseCooldown;
      const charge = ready ? Math.min(1, held / cfg.poseHold) : 0;

      let fired = null;
      if (ready && held >= cfg.poseHold) {
        fired = { count, direction, thumb };
        spent = key;          // hold it as long as you like; it fires once
        firedAt = now;
      }

      return { count, direction, thumb, thumbGap, lean, charge, fired, valid };
    },

    reset: idle,
  };
}
