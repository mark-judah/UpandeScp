/**
 * The cover that holds the screen while the app gets on its feet.
 *
 * Frappe shows one on every desk navigation; crossing between the desk and this
 * app is a full document load in both directions, and without a cover that
 * crossing is a flash of half-painted page. The markup and the styling live in
 * `www/scp_app.html` so the cover is on screen in the first frame, before this
 * bundle — or its stylesheet — has loaded. This module only decides when it
 * comes down.
 *
 * Coming IN is the only direction that needs one. Leaving for the desk raises
 * Frappe's own splash the moment /app starts loading, and two covers handing
 * over to each other is one more than the crossing needs.
 *
 * WHEN IT COMES DOWN. Three conditions, in order:
 *
 *  1. React has painted. Uncovering a root React has been handed but not yet
 *     drawn shows the blank frame the cover exists to hide.
 *  2. A second has passed. A cover that flashes off after thirty milliseconds
 *     is a flicker, not a transition — it reads as a glitch rather than as the
 *     app opening.
 *  3. The first data has landed, but only briefly — see the cap below.
 *     Every endpoint goes through `call` in lib/frappe, so the number of
 *     requests in flight is known here without a single page having to say
 *     anything. When the data is quick, waiting for it means uncovering onto
 *     real figures instead of onto a skeleton that is replaced a moment later.
 *
 * THE CAP IS THE INTERESTING PART, and it is why this differs from the
 * `upande_livestock` version it was ported from. There the cover waits up to
 * six seconds for data. Here that is wrong, because this app has page
 * skeletons: past a second or two the cover is no longer hiding a blank frame,
 * it is hiding the skeleton — and a skeleton is strictly better to look at than
 * a logo, because it says what is coming and the chrome around it is already
 * usable. Measured on the SCP dashboard, a six-second cap held the logo for the
 * full six seconds on a normal load.
 *
 * So the data wait is capped at 2.5s and the skeletons take it from there. The
 * dashboard's aggregates can be a 16-second rebuild on a cold cache; nothing
 * would justify holding a logo in front of somebody for that.
 */

const ID = "scp-splash";
const FADE_MS = 280;
/** The floor. Below this the cover reads as a flicker. */
const MIN_MS = 1000;
/** The ceiling on waiting for data. Past this the skeletons are the better
 *  thing to be looking at, so the cover goes whether or not data has landed. */
const CAP_MS = 2500;

const openedAt =
  typeof performance !== "undefined" ? performance.now() : Date.now();

let painted = false;
let inFlight = 0;
let dismissed = false;
let timer: number | undefined;

function since(): number {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return now - openedAt;
}

function hide(): void {
  if (dismissed) return;
  dismissed = true;
  const el = document.getElementById(ID);
  if (!el) return;
  el.classList.add("scp-leaving");
  window.setTimeout(() => el.remove(), FADE_MS + 40);
}

/** Re-evaluate the three conditions, and schedule the next look if it is not
 *  time yet. */
function settle(): void {
  if (dismissed || !painted) return;
  window.clearTimeout(timer);

  const waited = since();
  if (waited < MIN_MS) {
    timer = window.setTimeout(settle, MIN_MS - waited);
    return;
  }
  if (inFlight > 0 && waited < CAP_MS) {
    // Nothing to do: the request that finishes will call back in here. The
    // timer is only the backstop for one that never does.
    timer = window.setTimeout(settle, CAP_MS - waited);
    return;
  }
  hide();
}

/** Called once React has actually drawn something. */
export function markPainted(): void {
  painted = true;
  settle();
}

/** Bracketing for lib/frappe's `call`, so the cover knows what is outstanding. */
export function requestStarted(): void {
  inFlight += 1;
}

export function requestFinished(): void {
  inFlight = Math.max(0, inFlight - 1);
  settle();
}
