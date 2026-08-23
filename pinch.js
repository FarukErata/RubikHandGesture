// Turns a stream of hand landmarks into two discrete gestures:
//
//   pinch  — a button. Thumb tip to index tip, scale-invariant, hysteresis.
//   swipe  — a flick of the open hand. Palm velocity, one shot per stroke.
//
// Everything here works in *screen pixels* (post-toScreen), not normalized
// units: normalized x and y have different scales, so distances computed on
// them are skewed by the aspect ratio.

export const CONFIG = {
  // pinch ratio = dist(thumb tip, index tip) / dist(wrist, middle MCP).
  // Open hand sits near 0.7–1.0, a firm pinch near 0.15–0.25. Two thresholds
  // (Schmitt trigger) or the gesture chatters at the boundary.
  pinchOn: 0.25,   // below this: pinch closes
  pinchOff: 0.35,  // above this: pinch opens
  pinchHold: 90,   // ms the pinch must survive before it counts as a press —
                   // a relaxed hand dips under the threshold for a frame or two
  openRatio: 0.5,  // above this the hand counts as open, and the pointer
                   // position is remembered as the grab anchor
  alpha: 0.5,      // EMA factor for the pointer position

  swipeEnabled: true,
  swipeSpeed: 450,    // px/s of palm travel needed to fire
  swipeDist: 45,      // ...and the stroke must have covered this far, so that
                      // a fast twitch in place can't fire one
  swipeRearm: 180,    // must slow below this before another swipe can fire
  swipeRatio: 1.5,    // dominant axis must beat the other by this much
  swipeCooldown: 400, // ms
};

const TIP_THUMB = 4, TIP_INDEX = 8, WRIST = 0, MCP_MIDDLE = 9;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function createHandTracker(config = {}) {
  const cfg = { ...CONFIG, ...config };

  let closed = false;    // raw ratio state
  let pinching = false;  // debounced: what the rest of the app sees
  let closedAt = 0;
  let pos = null;        // smoothed pinch point, screen px
  let anchor = null;     // last pos while the hand was still open
  let ratio = null;      // smoothed pinch ratio
  let palm = null, palmT = 0;
  let strokeFrom = null; // where the current fast movement began
  let armed = true, lastSwipe = -Infinity;
  // exposed for the live readout: without these there's no way to tell how
  // close a gesture came to firing
  let speed = 0, stroke = 0;

  const ema = (prev, next) => prev == null ? next : prev + (next - prev) * cfg.alpha;

  function lost() {
    const released = pinching;
    closed = pinching = false;
    pos = ratio = palm = anchor = strokeFrom = null;
    armed = true;
    return { visible: false, pinching: false, released, pressed: false, swipe: null };
  }

  return {
    config: cfg,

    /** Call once per frame. `lms` is one hand's landmarks, or null if none. */
    update(lms, toScreen, now = performance.now()) {
      if (!lms) return lost();

      const thumb = toScreen(lms[TIP_THUMB]);
      const index = toScreen(lms[TIP_INDEX]);
      const wrist = toScreen(lms[WRIST]);
      const mcp   = toScreen(lms[MCP_MIDDLE]);

      // wrist → middle MCP is a rigid span: it doesn't change with finger
      // flex, so the quotient is invariant to how close the hand is
      const span = Math.max(1e-6, dist(wrist, mcp));
      ratio = ema(ratio, dist(thumb, index) / span);

      if (!closed && ratio < cfg.pinchOn) { closed = true; closedAt = now; }
      if (closed && ratio > cfg.pinchOff) closed = false;

      // a press only lands once the pinch has held, so brief dips are ignored
      const was = pinching;
      pinching = closed && now - closedAt >= cfg.pinchHold;

      const raw = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
      pos = pos == null ? raw : { x: ema(pos.x, raw.x), y: ema(pos.y, raw.y) };

      // Closing the fingers drags the midpoint along with them, so by the time
      // the press lands the pointer has already left the target. Remember where
      // it was while the hand was still open and grab there instead.
      if (ratio > cfg.openRatio) anchor = pos;

      // palm centre: barely moves when the fingers do, so it's what decides
      // which zone the hand is in
      const palmPos = { x: (wrist.x + mcp.x) / 2, y: (wrist.y + mcp.y) / 2 };

      return {
        visible: true,
        x: pos.x, y: pos.y, ratio,
        palmX: palmPos.x, palmY: palmPos.y,
        // where a press should grab: the last open-hand position
        grabX: (anchor ?? pos).x,
        grabY: (anchor ?? pos).y,
        pinching,
        closing: closed && !pinching, // pinch registered, still inside pinchHold
        pressed: !was && pinching,
        released: was && !pinching,
        swipe: this._swipe(wrist, mcp, now, pinching),
        // diagnostics for the readout
        speed, stroke, armed,
      };
    },

    // Palm centre velocity. Only fires with the hand open, and only once per
    // stroke — the return stroke would otherwise fire the opposite direction.
    _swipe(wrist, mcp, now, pinching) {
      const p = { x: (wrist.x + mcp.x) / 2, y: (wrist.y + mcp.y) / 2 };
      const prev = palm, dt = (now - palmT) / 1000;
      palm = p; palmT = now;

      if (!cfg.swipeEnabled) return null;
      if (!prev || dt <= 0 || dt > 0.2) return null; // gap in frames: no velocity

      const vx = (p.x - prev.x) / dt, vy = (p.y - prev.y) / dt;
      // smoothed: frame-to-frame velocity at 30fps is far too noisy to
      // threshold directly, and unreadable in a readout
      speed = speed * 0.4 + Math.hypot(vx, vy) * 0.6;

      // a stroke starts when the hand gets moving, and is measured from there:
      // speed alone fires on a twitch, distance alone fires on a slow reposition
      if (speed < cfg.swipeRearm) { armed = true; strokeFrom = null; }
      else if (!strokeFrom) strokeFrom = prev;

      const dx = p.x - (strokeFrom?.x ?? prev.x);
      const dy = p.y - (strokeFrom?.y ?? prev.y);
      stroke = Math.hypot(dx, dy);

      if (pinching || !armed) return null;
      if (speed < cfg.swipeSpeed) return null;
      if (now - lastSwipe < cfg.swipeCooldown) return null;
      if (stroke < cfg.swipeDist) return null;

      // direction from the whole stroke, not the last frame
      const horizontal = Math.abs(dx) > Math.abs(dy) * cfg.swipeRatio;
      const vertical   = Math.abs(dy) > Math.abs(dx) * cfg.swipeRatio;
      if (!horizontal && !vertical) return null; // diagonal: ambiguous, ignore

      armed = false;
      strokeFrom = null;
      lastSwipe = now;
      return horizontal ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    },

    reset: lost,
  };
}
