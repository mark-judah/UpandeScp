// Frappe hard-codes target="_blank" on every URL-type workspace-sidebar item
// (sidebar_item.html), so the SCP sidebar links (Scout Map, Create/Approve
// Spray Plan → /scp_app) open a new tab. Intercept those clicks and navigate
// in the current tab instead. Capture phase so we win before Frappe's handler.
document.addEventListener(
	"click",
	function (e) {
		var a = e.target && e.target.closest && e.target.closest("a[href]");
		if (!a) return;
		var href = a.getAttribute("href") || "";
		if (href.indexOf("/scp_app") === 0) {
			e.preventDefault();
			e.stopPropagation();
			window.location.href = href;
		}
	},
	true
);
