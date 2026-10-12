// The SCP tile on the desk's apps screen, animated on hover.
//
// The artwork and the story are the Upande Webstore mark's: a cart rolls in, a
// rose blooms in its basket, and the Upande arrow rises out of it while the
// cart falls away. The Webstore plays it once on load; SCP plays it on hover —
// eased in while the pointer (or keyboard focus) is on the tile, eased back out
// to the resting arrow badge when it leaves. Leaving part-way reverses from
// wherever it had got to, so it never snaps.
//
// Why script at all: the desk draws app tiles as <img>, and hover never reaches
// an SVG inside an <img>. So the tile's <img> is swapped for the same file
// inlined, and the Web Animations API drives it (a CSS animation cannot be
// reversed from its current point). If any of this fails the <img> stays — the
// resting mark, which is what the file draws on its own.
(function () {
	var SRC = "/assets/upande_scp/images/scp_logo.svg";
	var DURATION = 1800;
	var EASE = "cubic-bezier(.3,.7,.2,1)";
	var svgText = null;
	var loading = null;

	if (typeof Element === "undefined" || !Element.prototype.animate) return;
	var reduce =
		window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (reduce) return;

	function fetchSvg() {
		if (svgText) return Promise.resolve(svgText);
		if (!loading) {
			loading = fetch(SRC, { credentials: "same-origin" })
				.then(function (r) {
					if (!r.ok) throw new Error(r.status);
					return r.text();
				})
				.then(function (t) {
					svgText = t;
					return t;
				});
		}
		return loading;
	}

	// One timeline from the resting badge (0) to the cart holding the rose (1):
	// the arrow lifts and shrinks, sinks into the basket as the cart rolls in
	// under it, then the rose blooms. Played forward on hover, backward on leave.
	function effects(svg) {
		var all = function (sel) {
			return Array.prototype.slice.call(svg.querySelectorAll(sel));
		};
		var out = [];
		var timing = { duration: DURATION, easing: EASE, fill: "both" };
		all(".goods").forEach(function (el) {
			out.push(
				el.animate(
					[
						{ opacity: 0, transform: "translate(0, 10px)", offset: 0 },
						{ opacity: 1, transform: "translate(0, 0)", offset: 0.25 },
						{ opacity: 1, transform: "translate(0, 0)", offset: 1 },
					],
					timing
				)
			);
		});
		all(".cart").forEach(function (el) {
			out.push(
				el.animate(
					[
						{ transform: "translate(-70px, 0)", offset: 0 },
						{ transform: "translate(0, 0)", offset: 0.45 },
						{ transform: "translate(0, 0)", offset: 1 },
					],
					timing
				)
			);
		});
		all(".rose").forEach(function (el) {
			el.style.transformBox = "view-box";
			el.style.transformOrigin = "50px 46px";
			out.push(
				el.animate(
					[
						{ transform: "scale(0)", offset: 0 },
						{ transform: "scale(0)", offset: 0.5 },
						{ transform: "scale(1)", offset: 0.85 },
						{ transform: "scale(1)", offset: 1 },
					],
					timing
				)
			);
		});
		all(".arrow").forEach(function (el) {
			el.style.transformBox = "view-box";
			el.style.transformOrigin = "50px 50px";
			out.push(
				el.animate(
					[
						{ transform: "translate(0, 0) scale(1)", opacity: 1, offset: 0 },
						{ transform: "translate(0, -18px) scale(.36)", opacity: 1, offset: 0.3 },
						{ transform: "translate(0, -18px) scale(.36)", opacity: 1, offset: 0.4 },
						{ transform: "translate(0, 14px) scale(.3)", opacity: 0, offset: 0.62 },
						{ transform: "translate(0, 14px) scale(.3)", opacity: 0, offset: 1 },
					],
					timing
				)
			);
		});
		out.forEach(function (a) {
			a.pause();
			a.currentTime = 0;
		});
		return out;
	}

	function drive(anims, forward) {
		anims.forEach(function (a) {
			var t = Number(a.currentTime) || 0;
			// play() on a finished animation seeks to the far end: already at the
			// end it is heading for, it stays put instead of jumping.
			if (forward ? t >= DURATION : t <= 0) {
				a.pause();
				return;
			}
			a.playbackRate = forward ? 1 : -1;
			a.play();
		});
	}

	function upgrade(img) {
		if (img.dataset.scpMotion) return;
		img.dataset.scpMotion = "1";
		fetchSvg()
			.then(function (text) {
				if (!img.isConnected) return;
				var holder = document.createElement("div");
				holder.innerHTML = text;
				var svg = holder.querySelector("svg");
				if (!svg) return;
				svg.setAttribute("class", img.className || "app-icon");
				svg.setAttribute("aria-label", img.alt || "SCP");
				svg.removeAttribute("width");
				svg.removeAttribute("height");
				svg.style.width = "100%";
				svg.style.height = "100%";
				svg.style.display = "block";
				img.replaceWith(svg);

				var anims = effects(svg);
				var tile = svg.closest(".desktop-icon") || svg.parentElement;
				var on = function () {
					drive(anims, true);
				};
				var off = function () {
					drive(anims, false);
				};
				tile.addEventListener("mouseenter", on);
				tile.addEventListener("mouseleave", off);
				tile.addEventListener("focusin", on);
				tile.addEventListener("focusout", off);
			})
			.catch(function () {
				// Keep the <img>: the resting mark.
			});
	}

	function scan(root) {
		var imgs = (root || document).querySelectorAll(
			'.desktop-icon img.app-icon[src*="scp_logo.svg"]'
		);
		for (var i = 0; i < imgs.length; i++) upgrade(imgs[i]);
	}

	// The apps screen is re-rendered on navigation and on edits; watch for tiles.
	var queued = false;
	function onMutate() {
		if (queued) return;
		queued = true;
		requestAnimationFrame(function () {
			queued = false;
			scan(document);
		});
	}
	function start() {
		scan(document);
		new MutationObserver(onMutate).observe(document.body, { childList: true, subtree: true });
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})();
