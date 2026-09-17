// The cover that holds the desk while the SCP app loads.
//
// Frappe raises a splash on its own navigations, but leaving the desk for
// /scp_app is a full document load, and without a cover the desk sits there
// looking clickable for as long as the bundle takes. The app shell raises the
// same cover on its own side (www/scp_app.html), so the two page loads read as
// one continuous crossing rather than two separate blank moments.
//
// Everything is inline — no class, no stylesheet — because this runs as the
// document is being torn down, and a rule in a stylesheet the browser is
// already discarding paints nothing.
(function () {
	var ID = "scp-splash";

	window.__scpSplash = function () {
		if (document.getElementById(ID)) return;
		var el = document.createElement("div");
		el.id = ID;
		el.setAttribute(
			"style",
			"position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;" +
				"justify-content:center;background:#ffffff"
		);
		var img = document.createElement("img");
		img.src = "/assets/upande_scp/images/upande_mark.svg";
		img.alt = "Upande SCP";
		img.setAttribute("style", "width:106px;height:auto;display:block");
		el.appendChild(img);
		document.body.appendChild(el);
	};
})();

// Same-tab navigation for /scp_app.
//
// Frappe hard-codes target="_blank" on every URL-type workspace-sidebar item
// (sidebar_item.html), so a sidebar link to the React app opens a new tab.
// Intercept those clicks and navigate in the current tab instead. Capture
// phase, so this wins before Frappe's own handler. Scoped to /scp_app — every
// other link on the desk is left alone.
//
// This used to read `e.target.closest("a[href]")`, which silently missed the
// launcher on the SCP workspace itself: that card lives in a Custom HTML Block,
// and `frappe.create_shadow_element` renders those inside an *open* shadow
// root. For an event originating in a shadow tree, `e.target` is retargeted to
// the shadow HOST, so `closest()` never sees the anchor and the click fell
// through to Frappe's handler — i.e. the one link people actually use opened a
// new tab. `e.composedPath()` is not retargeted; it lists the real path through
// the shadow DOM, so walk that instead.
(function () {
	// Paint the cover, then navigate on the next frame — assign location.href
	// in the same tick and the browser never paints what was just appended.
	function leave(href) {
		try {
			window.__scpSplash();
		} catch (_) {}
		requestAnimationFrame(function () {
			setTimeout(function () {
				window.location.href = href;
			}, 60);
		});
	}

	document.addEventListener(
		"click",
		function (e) {
			var path =
				typeof e.composedPath === "function" ? e.composedPath() : [e.target];
			var a = null;
			for (var i = 0; i < path.length; i++) {
				var el = path[i];
				if (el && el.tagName === "A" && el.hasAttribute && el.hasAttribute("href")) {
					a = el;
					break;
				}
			}
			if (!a) return;
			var href = a.getAttribute("href") || "";
			if (href.indexOf("/scp_app") === 0) {
				e.preventDefault();
				e.stopPropagation();
				leave(href);
			}
		},
		true
	);
})();
