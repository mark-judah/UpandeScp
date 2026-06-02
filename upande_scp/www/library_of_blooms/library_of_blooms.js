/* ════════════════════════════════════════════════════════════════
   LIBRARY OF BLOOMS — interaction + data
   Chapters are data-driven: add an object to CHAPTERS and a fully
   styled, animated chapter appears. Nothing else to touch.
   ════════════════════════════════════════════════════════════════ */
(function () {
	"use strict";

	var U = "https://images.unsplash.com/photo-";
	function img(id, w) {
		return U + id + "?auto=format&fit=crop&w=" + (w || 1500) + "&q=72";
	}
	// Real Karen Roses variety cut-outs extracted from the catalogue PDF.
	function flower(slug) { return "/library_of_blooms/assets/flowers/" + slug + ".png"; }

	var COVER_IMG = img("1597826368522-9f4cb5a6ba48", 1400);
	var CLOSING_IMG = img("1536266694648-914d29a935f9", 1900);

	// ── The catalogue. Append here to add chapters. ──────────────────
	var CHAPTERS = [
		{
			key: "signature", title: "Signature Collection", short: "Signature", dark: true,
			accent: "#c9a24b", accentInk: "#f6efe1", wash: "#13281d", cornerArt: "1", stemArt: "6",
			tagline: "Curated Icons of Floral Beauty",
			intro: "The roses we return to again and again — handcrafted with intention, inspired by nature, and made to be remembered.",
			hero: flower("radiant-rebecca"),
			varieties: [
				{ name: "Magical Rosever", img: flower("magical-rosever") },
				{ name: "Bellalinda Love", img: flower("bellalinda-love") },
				{ name: "Harper", img: flower("harper") }
			]
		},
		{
			key: "white", title: "White Roses", short: "White", dark: false,
			accent: "#8d9a8c", accentInk: "#4c554a", wash: "#f1efe6", cornerArt: "5", stemArt: "7",
			tagline: "A Study in Purity & Grace",
			intro: "Crisp whites and luminous ivories, photographed true to tone. The bridal heart of the library — clean, quiet, and made for moments that ask for restraint.",
			hero: flower("snowstorm"),
			varieties: [
				{ name: "Athena", img: flower("athena") },
				{ name: "Snow Bubbles", img: flower("snow-bubbles") },
				{ name: "Milkyway", img: flower("milkyway") },
				{ name: "Miss Bombastic", img: flower("miss-bombastic") },
				{ name: "Snowy Trendsetter", img: flower("snowy-trendsetter") },
				{ name: "Wedding Invite", img: flower("wedding-invite") },
				{ name: "Lyrica", img: flower("lyrica") }
			]
		},
		{
			key: "cream", title: "Cream Roses", short: "Cream", dark: false,
			accent: "#c2a76b", accentInk: "#6f5d35", wash: "#f6efdd", cornerArt: "3", stemArt: "2",
			tagline: "Timeless Elegance in Every Petal",
			intro: "Soft buttermilk and antique-ivory tones that warm any palette. The cream collection is understated luxury, cut for elegance.",
			hero: flower("summer-rose"),
			varieties: [
				{ name: "Gentle Trendsetter", img: flower("gentle-trendsetter") },
				{ name: "Sofie", img: flower("sofie") },
				{ name: "Sancerre", img: flower("sancerre") },
				{ name: "Rosanella", img: flower("rosanella") },
				{ name: "Salinero", img: flower("salinero") }
			]
		},
		{
			key: "peach", title: "Peach Roses", short: "Peach", dark: false,
			accent: "#db8b58", accentInk: "#9a5a33", wash: "#fbe7d6", cornerArt: "4", stemArt: "9",
			tagline: "Where Softness Meets Warmth",
			intro: "Gentle apricot and sun-warmed blush. The peach collection brings a tender glow — romantic without ever being loud.",
			hero: flower("julieta"),
			varieties: [
				{ name: "Azore", img: flower("azore") },
				{ name: "Sweet Sara", img: flower("sweet-sara") },
				{ name: "Coral Springs", img: flower("coral-springs") }
			]
		},
		{
			key: "coral", title: "Coral Roses", short: "Coral", dark: false,
			accent: "#df6f5a", accentInk: "#a23f32", wash: "#fbdfd6", cornerArt: "8", stemArt: "10",
			tagline: "A Warm Embrace of Colour",
			intro: "Where pink meets orange in the happiest way. Coral roses carry energy and warmth, vivid yet still soft to the eye.",
			hero: flower("barbados"),
			varieties: [
				{ name: "Femke", img: flower("femke") },
				{ name: "Holly", img: flower("holly") },
				{ name: "Amazing Magic", img: flower("amazing-magic") }
			]
		},
		{
			key: "orange", title: "Orange Roses", short: "Orange", dark: false,
			accent: "#d96d2c", accentInk: "#9c4413", wash: "#fbe2cb", cornerArt: "10", stemArt: "4",
			tagline: "Vibrance with a Fiery Heart",
			intro: "Bold, sunlit and full of life. The orange collection is the boldest warm chapter — from soft mango to blazing flame.",
			hero: flower("on-fire"),
			varieties: [
				{ name: "Ariya", img: flower("ariya") },
				{ name: "Orange Babe", img: flower("orange-babe") },
				{ name: "Amina", img: flower("amina") },
				{ name: "Copacabana", img: flower("copacabana") },
				{ name: "Tropical Amazon", img: flower("tropical-amazon") },
				{ name: "Eyeliner", img: flower("eyeliner") },
				{ name: "Land of Fire", img: flower("land-of-fire") },
				{ name: "High & Magic", img: flower("high-and-magic") },
				{ name: "Summerfield", img: flower("summerfield") },
				{ name: "Espana", img: flower("espana") },
				{ name: "Fireflash", img: flower("fireflash") },
				{ name: "Summerdance", img: flower("summerdance") }
			]
		},
		{
			key: "yellow", title: "Yellow Roses", short: "Yellow", dark: false,
			accent: "#c2962e", accentInk: "#876213", wash: "#f8edcd", cornerArt: "2", stemArt: "8",
			tagline: "Sunlight Caught in Petal",
			intro: "Warmth and friendship made flower. Buttery yellows through to deep amber gold — vivid, cheerful, and full of light.",
			hero: flower("yelloween"),
			varieties: [
				{ name: "Marissa", img: flower("marissa") },
				{ name: "Yellow Babe", img: flower("yellow-babe") },
				{ name: "Boomer", img: flower("boomer") },
				{ name: "Moonwalk", img: flower("moonwalk") }
			]
		},
		{
			key: "lilac", title: "Lilac Roses", short: "Lilac", dark: false,
			accent: "#9b80b3", accentInk: "#5f4576", wash: "#efe6f4", cornerArt: "6", stemArt: "1",
			tagline: "A Whisper of Soft Mauve",
			intro: "Delicate and dreamlike. The lilac collection drifts between grey, mauve and lavender — quiet sophistication in every stem.",
			hero: flower("thriller"),
			varieties: [
				{ name: "Silver Shadows", img: flower("silver-shadows") },
				{ name: "Leila", img: flower("leila") },
				{ name: "Nightingale", img: flower("nightingale") }
			]
		},
		{
			key: "purple", title: "Purple Roses", short: "Purple", dark: false,
			accent: "#6f4a93", accentInk: "#432c5e", wash: "#e7ddf0", cornerArt: "7", stemArt: "3",
			tagline: "Bold Elegance in Bloom",
			intro: "Rare, regal and unmistakable. Deep purple roses bring drama and depth — a statement of bold elegance.",
			hero: flower("misty-bubbles"),
			varieties: []
		},
		{
			key: "cerise", title: "Cerise Roses", short: "Cerise", dark: false,
			accent: "#c0306c", accentInk: "#7d1a45", wash: "#f7d9e6", cornerArt: "9", stemArt: "5",
			tagline: "When Bold Becomes Beautiful",
			intro: "Vivid, confident and joyful. Cerise sits between pink and magenta — the colour of celebration, cut for impact.",
			hero: flower("madam-cerise"),
			varieties: [
				{ name: "Giselle", img: flower("giselle") },
				{ name: "Dima Bombastic", img: flower("dima-bombastic") },
				{ name: "Lady Bombastic", img: flower("lady-bombastic") },
				{ name: "Julieta Cerise", img: flower("julieta-cerise") },
				{ name: "Bellalinda Cerise", img: flower("bellalinda-cerise") },
				{ name: "Cherry Blossom", img: flower("cherry-blossom") },
				{ name: "Classic Sensation", img: flower("classic-sensation") },
				{ name: "Pink Dimension", img: flower("pink-dimension") },
				{ name: "Alicia", img: flower("alicia") },
				{ name: "Cheyenne", img: flower("cheyenne") },
				{ name: "Tessa", img: flower("tessa") },
				{ name: "Candidate", img: flower("candidate") },
				{ name: "Fusciana", img: flower("fusciana") }
			]
		},
		{
			key: "pink", title: "Pink Roses", short: "Pink", dark: false,
			accent: "#d56a93", accentInk: "#8d3258", wash: "#fbe1ec", cornerArt: "4", stemArt: "2",
			tagline: "Soft in Petal, Big in Heart",
			intro: "The most beloved chapter — endlessly versatile, from pale blush to bright rose. Pink roses suit both the everyday and the unforgettable.",
			hero: flower("smoothie"),
			varieties: [
				{ name: "Silver Pink", img: flower("silver-pink") },
				{ name: "Sweet Giselle!", img: flower("sweet-giselle") },
				{ name: "Bombastic", img: flower("bombastic") },
				{ name: "Madam Bombastic", img: flower("madam-bombastic") },
				{ name: "Britney", img: flower("britney") },
				{ name: "Inker Kristine", img: flower("inker-kristine") },
				{ name: "Good Mood", img: flower("good-mood") },
				{ name: "Tralala", img: flower("tralala") },
				{ name: "Dinara", img: flower("dinara") },
				{ name: "Odilia", img: flower("odilia") },
				{ name: "Fairflow", img: flower("fairflow") },
				{ name: "Reflex", img: flower("reflex") },
				{ name: "Wham", img: flower("wham") },
				{ name: "Charlize!", img: flower("charlize") },
				{ name: "Brooke!", img: flower("brooke") },
				{ name: "Athena Royale", img: flower("athena-royale") },
				{ name: "Wendy Kristy", img: flower("wendy-kristy") },
				{ name: "Aqua!", img: flower("aqua") },
				{ name: "Tapdance", img: flower("tapdance") },
				{ name: "Pink Athena", img: flower("pink-athena") },
				{ name: "Pink Ice", img: flower("pink-ice") }
			]
		},
		{
			key: "red", title: "Red Roses", short: "Red", dark: false,
			accent: "#9e2230", accentInk: "#5e131d", wash: "#f3d6d6", cornerArt: "6", stemArt: "10",
			tagline: "The Timeless Language of Love",
			intro: "Depth of colour and a velvet weight to every petal. Our reds are cut for ceremony and statement, holding their form from field to vase.",
			hero: flower("furiosa"),
			varieties: [
				{ name: "Red Trendsetter", img: flower("red-trendsetter") },
				{ name: "In Love", img: flower("in-love") },
				{ name: "Pushkin", img: flower("pushkin") },
				{ name: "Dominica", img: flower("dominica") },
				{ name: "Mirabel", img: flower("mirabel") },
				{ name: "Fireworks", img: flower("fireworks") },
				{ name: "Ever Red", img: flower("ever-red") },
				{ name: "Explorer", img: flower("explorer") },
				{ name: "Madam Red", img: flower("madam-red") },
				{ name: "Red Calypso", img: flower("red-calypso") }
			]
		},
		{
			key: "fillers", title: "Fillers Collection", short: "Fillers", dark: false,
			accent: "#6f8f6a", accentInk: "#3f5a3c", wash: "#e8efe2", cornerArt: "8", stemArt: "6",
			tagline: "Soft Details, Lasting Impressions",
			intro: "The supporting cast that makes every bouquet sing — foliage, textures and accents that frame the bloom and finish the story.",
			hero: flower("lamira"),
			varieties: [
				{ name: "Lamira Red", img: flower("lamira-red") },
				{ name: "Veronica", img: flower("veronica") },
				{ name: "Ofir", img: flower("ofir") },
				{ name: "Nairobi", img: flower("nairobi") },
				{ name: "Pinacolada", img: flower("pinacolada") },
				{ name: "Gypsophillas", img: flower("gypsophillas") },
				{ name: "Pavilion Blue", img: flower("pavilion-blue") },
				{ name: "Enchante", img: flower("enchante") },
				{ name: "Oshi Lilac", img: flower("oshi-lilac") },
				{ name: "Eucalyptus", img: flower("eucalyptus") },
				{ name: "Eryngium", img: flower("eryngium") },
				{ name: "Hard Ruscus", img: flower("hard-ruscus") },
				{ name: "Papyrus", img: flower("papyrus") },
				{ name: "Lepidium", img: flower("lepidium") }
			]
		},
		{
			key: "just", title: "The Just Series", short: "Just", dark: true,
			accent: "#c9a24b", accentInk: "#f6efe1", wash: "#13281d", cornerArt: "3", stemArt: "1",
			tagline: "Just the Right Bloom for Every Story",
			intro: "Our garden-rose signature line. Lush, many-petalled and full of character — just the right bloom for every story.",
			hero: flower("just-peach"),
			varieties: [
				{ name: "Just More", img: flower("just-more") },
				{ name: "Just Pink", img: flower("just-pink") },
				{ name: "Just Priscilla", img: flower("just-priscilla") },
				{ name: "Just Sweet", img: flower("just-sweet") }
			]
		}
	];

	var ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI"];

	function el(html) {
		var t = document.createElement("template");
		t.innerHTML = html.trim();
		return t.content.firstChild;
	}
	function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
		return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
	}); }

	function archImg(src, parallax) {
		return (
			'<div class="lob-arch-frame">' +
				'<div class="lob-arch-img lob-loading"' + (parallax ? ' data-parallax' : "") + ' data-src="' + src + '"></div>' +
				'<svg class="lob-arch-svg" viewBox="0 0 200 252" preserveAspectRatio="none"><use href="#lob-arch"/></svg>' +
			"</div>"
		);
	}

	function renderChapter(ch, i) {
		var cards = ch.varieties.map(function (v) {
			var slug = v.img.split("/").pop().replace(".png", "");
			return (
				'<article class="lob-card" data-reveal>' +
					'<div class="lob-card-arch">' +
						'<div class="lob-arch-img lob-loading" data-src="' + v.img + '"></div>' +
						'<svg class="lob-arch-svg" viewBox="0 0 200 252" preserveAspectRatio="none"><use href="#lob-arch"/></svg>' +
						'<button class="lob-like" type="button" data-slug="' + slug + '" data-name="' + esc(v.name) +
							'" data-section="' + esc(ch.short) + '" aria-label="Save ' + esc(v.name) + '" aria-pressed="false">' +
							'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>' +
						"</button>" +
					"</div>" +
					'<div class="lob-card-name">' + esc(v.name) + "</div>" +
				"</article>"
			);
		}).join("");

		var tint = ch.dark ? "gold" : "ink";          // bg engravings: gold on dark, ink on light
		var grid = ch.varieties.length
			? '<div class="lob-varieties" data-bg="#fbf6ec">' +
					'<div class="lob-varieties-head" data-reveal>' +
						'<p class="lob-eyebrow">The ' + esc(ch.short) + " Collection</p>" +
						"<h3>Featured Varieties</h3>" +
					"</div>" +
					'<div class="lob-grid">' + cards + "</div>" +
				"</div>"
			: "";

		var section = el(
			'<section id="sec-' + ch.key + '" class="lob-chapter' + (ch.dark ? " is-dark" : "") + '" style="--accent:' + ch.accent +
				";--accent-ink:" + ch.accentInk + ";--wash:" + ch.wash + '">' +
				'<div class="lob-chap-divider" data-bg="' + ch.wash + '">' +
					'<img class="lob-bg-art ' + tint + ' pos-chap-corner" src="/library_of_blooms/assets/' + ch.cornerArt + '.svg" alt="" />' +
					'<img class="lob-bg-art ' + tint + ' pos-chap-stem" src="/library_of_blooms/assets/' + ch.stemArt + '.svg" alt="" />' +
					'<div class="lob-chap-text">' +
						'<div class="lob-chap-no" data-reveal>Chapter ' + (ROMAN[i] || i + 1) + "</div>" +
						'<h2 class="lob-chap-title" data-reveal>' + esc(ch.title) + "</h2>" +
						'<p class="lob-chap-tag" data-reveal>' + esc(ch.tagline) + "</p>" +
						'<p class="lob-chap-intro" data-reveal>' + esc(ch.intro) + "</p>" +
					"</div>" +
					'<div class="lob-chap-hero" data-reveal>' + archImg(ch.hero) + "</div>" +
				"</div>" +
				grid +
			"</section>"
		);
		return section;
	}

	// ── Mount ────────────────────────────────────────────────────────
	function mount() {
		var host = document.getElementById("lob-chapters");
		CHAPTERS.forEach(function (ch, i) { host.appendChild(renderChapter(ch, i)); });

		// cover + closing imagery
		var cover = document.querySelector('.lob-parallax-img[data-img="cover"]');
		if (cover) cover.style.backgroundImage = "url('" + COVER_IMG + "')";
		var closing = document.querySelector('.lob-closing-photo[data-img="closing"]');
		if (closing) closing.style.backgroundImage = "url('" + CLOSING_IMG + "')";

		lazyImages();
		initInteractive();
		initMotion();
	}

	// Lazy-load the rose windows; show a flashing skeleton until each loads.
	function lazyImages() {
		var imgs = document.querySelectorAll(".lob-arch-img[data-src]");
		function load(node) {
			var src = node.getAttribute("data-src");
			if (!src) return;
			var pre = new Image();
			pre.onload = function () { node.style.backgroundImage = "url('" + src + "')"; node.classList.remove("lob-loading"); };
			pre.onerror = function () { node.classList.remove("lob-loading"); };
			pre.src = src; node.removeAttribute("data-src");
		}
		if (!("IntersectionObserver" in window)) { imgs.forEach(load); return; }
		var io = new IntersectionObserver(function (entries) {
			entries.forEach(function (e) { if (e.isIntersecting) { load(e.target); io.unobserve(e.target); } });
		}, { rootMargin: "300px 0px" });
		imgs.forEach(function (n) { io.observe(n); });
	}

	// ── Countries (name must match Frappe Country) → ISO2 + dial code ──
	var COUNTRIES = [
		["Kenya","KE","254"],["Uganda","UG","256"],["Tanzania","TZ","255"],["Rwanda","RW","250"],
		["Ethiopia","ET","251"],["Nigeria","NG","234"],["Ghana","GH","233"],["South Africa","ZA","27"],
		["Egypt","EG","20"],["Morocco","MA","212"],["United Kingdom","GB","44"],["Ireland","IE","353"],
		["France","FR","33"],["Germany","DE","49"],["Netherlands","NL","31"],["Belgium","BE","32"],
		["Spain","ES","34"],["Portugal","PT","351"],["Italy","IT","39"],["Switzerland","CH","41"],
		["Austria","AT","43"],["Sweden","SE","46"],["Norway","NO","47"],["Denmark","DK","45"],
		["Finland","FI","358"],["Poland","PL","48"],["Czech Republic","CZ","420"],["Romania","RO","40"],
		["Hungary","HU","36"],["Greece","GR","30"],["Russia","RU","7"],["Ukraine","UA","380"],
		["Turkey","TR","90"],["United States","US","1"],["Canada","CA","1"],["Mexico","MX","52"],
		["Brazil","BR","55"],["Argentina","AR","54"],["Colombia","CO","57"],["Chile","CL","56"],
		["Ecuador","EC","593"],["Peru","PE","51"],["United Arab Emirates","AE","971"],["Saudi Arabia","SA","966"],
		["Qatar","QA","974"],["Kuwait","KW","965"],["Bahrain","BH","973"],["Oman","OM","968"],
		["Israel","IL","972"],["Lebanon","LB","961"],["Jordan","JO","962"],["India","IN","91"],
		["Pakistan","PK","92"],["China","CN","86"],["Japan","JP","81"],["South Korea","KR","82"],
		["Singapore","SG","65"],["Malaysia","MY","60"],["Indonesia","ID","62"],["Thailand","TH","66"],
		["Philippines","PH","63"],["Vietnam","VN","84"],["Hong Kong","HK","852"],["Australia","AU","61"],
		["New Zealand","NZ","64"],["Luxembourg","LU","352"],["Iceland","IS","354"],["Cyprus","CY","357"],
		["Malta","MT","356"],["Croatia","HR","385"],["Bulgaria","BG","359"],["Slovakia","SK","421"],
		["Slovenia","SI","386"],["Lithuania","LT","370"],["Latvia","LV","371"],["Estonia","EE","372"]
	];
	function flagEmoji(iso) {
		return iso.toUpperCase().replace(/./g, function (c) { return String.fromCodePoint(127397 + c.charCodeAt(0)); });
	}
	function countryByName(name) { for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i][0] === name) return COUNTRIES[i]; return null; }
	function countryByDial(digits) {
		// longest dial-prefix match
		var best = null;
		for (var i = 0; i < COUNTRIES.length; i++) {
			var d = COUNTRIES[i][2];
			if (digits.indexOf(d) === 0 && (!best || d.length > best[2].length)) best = COUNTRIES[i];
		}
		return best;
	}

	/* ════════════════════════════════════════════════════════════════
	   INTERACTIVE LAYER — rose-bubble nav · like/favourite · EOI form
	   ════════════════════════════════════════════════════════════════ */
	var LKEY = "lob_likes";
	function getLikes() { try { return JSON.parse(localStorage.getItem(LKEY)) || []; } catch (e) { return []; } }
	function saveLikes(a) { try { localStorage.setItem(LKEY, JSON.stringify(a)); } catch (e) {} }
	function likedSlug(s) { return getLikes().some(function (x) { return x.slug === s; }); }
	var hintTimer;
	function showHint() {
		var h = document.querySelector(".lob-nav-hint");
		if (!h || getLikes().length) return;
		h.classList.add("show");
		clearTimeout(hintTimer);
		hintTimer = setTimeout(function () { h.classList.remove("show"); }, 6000);
	}
	function hideHint() {
		var h = document.querySelector(".lob-nav-hint");
		if (h) h.classList.remove("show");
		clearTimeout(hintTimer);
	}
	function toggleLike(slug, name, section) {
		var a = getLikes(), i = -1, k;
		for (k = 0; k < a.length; k++) { if (a[k].slug === slug) { i = k; break; } }
		if (i >= 0) a.splice(i, 1); else a.push({ slug: slug, name: name, section: section });
		saveLikes(a); syncLikeUI();
	}

	function initInteractive() {
		buildNav();
		buildTray();
		buildModal();

		var openBtn = document.getElementById("lob-open-eoi");
		if (openBtn) openBtn.addEventListener("click", openModal);
		document.addEventListener("keydown", function (e) {
			if (e.key === "Escape") { closeModal(); closeTray(); }
		});

		// heart toggles (event delegation)
		document.addEventListener("click", function (e) {
			var btn = e.target.closest && e.target.closest(".lob-like");
			if (!btn) return;
			// toggleLike() updates storage AND re-syncs every heart's class, so we
			// must NOT toggle the class here too (that would cancel it out).
			toggleLike(btn.getAttribute("data-slug"), btn.getAttribute("data-name"), btn.getAttribute("data-section"));
			if (btn.classList.contains("is-liked")) {
				btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop");
			}
		});

		syncLikeUI();
		if (!getLikes().length) setTimeout(showHint, 1400);  // gentle first-visit nudge
	}

	// ── Rose-bubble navigation ──
	function buildNav() {
		var dots = CHAPTERS.map(function (ch) {
			return '<button class="lob-nav-dot" type="button" data-target="sec-' + ch.key +
				'" style="--d:' + ch.accent + '"><i></i><span>' + esc(ch.title) + "</span></button>";
		}).join("");
		var nav = el(
			'<nav class="lob-nav" aria-label="Sections">' +
				'<span class="lob-nav-hint">Tap a&nbsp;♥&nbsp;on the roses you love to gather them here</span>' +
				'<div class="lob-nav-panel" hidden>' +
					'<button class="lob-nav-fav" type="button"><svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg> <span>Your blooms</span> <b class="lob-nav-count">0</b></button>' +
					'<div class="lob-nav-dots">' + dots + "</div>" +
					'<button class="lob-nav-top" type="button">↑ Top</button>' +
				"</div>" +
				'<button class="lob-nav-toggle" type="button" aria-label="Browse the catalogue">' +
					'<span class="lob-nav-icon" aria-hidden="true"></span>' +
					'<b class="lob-nav-badge is-empty" aria-hidden="true">♥</b>' +
				"</button>" +
			"</nav>"
		);
		document.body.appendChild(nav);
		var panel = nav.querySelector(".lob-nav-panel");
		var reduce = prefersReduce();
		var toggle = nav.querySelector(".lob-nav-toggle");
		toggle.addEventListener("click", function () {
			var open = nav.classList.toggle("is-open");
			panel.hidden = !open;
			hideHint();
		});
		toggle.addEventListener("mouseenter", function () { if (!getLikes().length) showHint(); });
		nav.querySelectorAll(".lob-nav-dot").forEach(function (d) {
			d.addEventListener("click", function () {
				var t = document.getElementById(d.getAttribute("data-target"));
				if (t) t.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
				nav.classList.remove("is-open"); panel.hidden = true;
			});
		});
		nav.querySelector(".lob-nav-top").addEventListener("click", function () {
			window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
			nav.classList.remove("is-open"); panel.hidden = true;
		});
		nav.querySelector(".lob-nav-fav").addEventListener("click", function () {
			nav.classList.remove("is-open"); panel.hidden = true; openTray();
		});
	}

	// ── Favourites tray ──
	function buildTray() {
		var tray = el(
			'<div class="lob-tray" hidden>' +
				'<div class="lob-tray-veil"></div>' +
				'<aside class="lob-tray-card" role="dialog" aria-label="Your gathered blooms">' +
					'<header><span>Your Gathered Blooms</span><button class="lob-tray-close" type="button" aria-label="Close">×</button></header>' +
					'<div class="lob-tray-list"></div>' +
					'<footer><button class="lob-tray-cta" type="button">Express your interest</button>' +
						'<button class="lob-tray-clear" type="button">Clear all</button></footer>' +
				"</aside>" +
			"</div>"
		);
		document.body.appendChild(tray);
		tray.querySelector(".lob-tray-veil").addEventListener("click", closeTray);
		tray.querySelector(".lob-tray-close").addEventListener("click", closeTray);
		tray.querySelector(".lob-tray-cta").addEventListener("click", function () { closeTray(); openModal(); });
		tray.querySelector(".lob-tray-clear").addEventListener("click", function () {
			if (!getLikes().length) return;
			saveLikes([]); syncLikeUI();
		});
		tray.addEventListener("click", function (e) {
			var r = e.target.closest && e.target.closest(".lob-tray-remove");
			if (!r) return;
			var slug = r.getAttribute("data-slug");
			toggleLike(slug);
			var card = document.querySelector('.lob-like[data-slug="' + slug + '"]');
			if (card) { card.classList.remove("is-liked"); card.setAttribute("aria-pressed", "false"); }
		});
	}
	function renderTray() {
		var list = document.querySelector(".lob-tray-list");
		if (!list) return;
		var likes = getLikes();
		var clear = document.querySelector(".lob-tray-clear");
		if (!likes.length) {
			list.innerHTML = '<p class="lob-tray-empty">No blooms gathered yet. Tap the ♥ on any rose you love and it will appear here.</p>';
			var cta = document.querySelector(".lob-tray-cta"); if (cta) cta.disabled = true;
			if (clear) clear.style.display = "none";
			return;
		}
		document.querySelector(".lob-tray-cta").disabled = false;
		if (clear) clear.style.display = "";
		list.innerHTML = likes.map(function (x) {
			return '<div class="lob-tray-item">' +
				'<span class="lob-tray-thumb" style="background-image:url(\'' + flower(x.slug) + '\')"></span>' +
				'<span class="lob-tray-meta"><b>' + esc(x.name) + "</b><i>" + esc(x.section || "") + "</i></span>" +
				'<button class="lob-tray-remove" type="button" data-slug="' + x.slug + '" aria-label="Remove">×</button>' +
			"</div>";
		}).join("");
	}
	function openTray() { renderTray(); var t = document.querySelector(".lob-tray"); if (t) { t.hidden = false; document.body.classList.add("lob-locked"); } }
	function closeTray() { var t = document.querySelector(".lob-tray"); if (t) { t.hidden = true; document.body.classList.remove("lob-locked"); } }

	// ── Expression-of-Interest modal ──
	var REQUESTS = ["Product Inquiry", "Partnership Inquiry", "General Inquiry", "Product Sample Request", "Quotation Request"];
	function buildModal() {
		var opts = REQUESTS.map(function (r) { return '<option value="' + r + '">' + r + "</option>"; }).join("");
		var cOpts = COUNTRIES.slice().sort(function (a, b) { return a[0] < b[0] ? -1 : 1; }).map(function (c) {
			return '<option value="' + c[0] + '" data-iso="' + c[1] + '" data-dial="' + c[2] + '"' + (c[0] === "Kenya" ? " selected" : "") + ">" + c[0] + "</option>";
		}).join("");
		var m = el(
			'<div class="lob-modal" hidden>' +
				'<div class="lob-modal-veil"></div>' +
				'<div class="lob-modal-card" role="dialog" aria-label="Express your interest">' +
					'<button class="lob-modal-close" type="button" aria-label="Close">×</button>' +
					'<svg class="lob-modal-crest" viewBox="263 356 215 215" aria-hidden="true"><use href="#lob-crest"/></svg>' +
					'<p class="lob-eyebrow gold">We\'d love to hear from you</p>' +
					'<h3 class="lob-modal-title">Express your Interest</h3>' +
					'<p class="lob-modal-intro">Tell us a little about you and our team will be in touch about the blooms you love.</p>' +
					'<div class="lob-modal-chips" hidden></div>' +
					'<form class="lob-eoi" novalidate>' +
						'<div class="lob-eoi-row">' +
							'<label>First name*<input name="first_name" required autocomplete="given-name"></label>' +
							'<label>Last name*<input name="last_name" required autocomplete="family-name"></label>' +
						"</div>" +
						'<label>Email*<input name="email_id" type="email" required autocomplete="email"></label>' +
						'<div class="lob-eoi-row">' +
							'<label>Country<select name="country">' + cOpts + "</select></label>" +
							'<label>Phone / WhatsApp*<span class="lob-phone"><span class="lob-flag">' + flagEmoji("KE") + '</span><input name="mobile_no" required inputmode="tel" autocomplete="tel" placeholder="+254 …"></span></label>' +
						"</div>" +
						'<label>I\'m interested in<select name="custom_request">' + opts + "</select></label>" +
						'<label>Message<textarea name="message" rows="3" placeholder="Anything you\'d like us to know…"></textarea></label>' +
						'<button class="lob-eoi-submit" type="submit">Send my interest</button>' +
						'<p class="lob-eoi-status" role="status"></p>' +
					"</form>" +
					'<div class="lob-modal-done" hidden>' +
						'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l5 5L20 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
						"<h3>Thank you</h3><p>Your interest is with our team — we'll be in touch soon.</p>" +
						'<button class="lob-modal-done-close" type="button">Close</button>' +
					"</div>" +
				"</div>" +
			"</div>"
		);
		document.body.appendChild(m);
		m.querySelector(".lob-modal-veil").addEventListener("click", closeModal);
		m.querySelector(".lob-modal-close").addEventListener("click", closeModal);
		m.querySelector(".lob-modal-done-close").addEventListener("click", closeModal);
		m.querySelector(".lob-eoi").addEventListener("submit", submitEoi);

		// Country ⇄ phone-flag interplay
		var cSel = m.querySelector('select[name="country"]');
		var pInp = m.querySelector('input[name="mobile_no"]');
		var flag = m.querySelector(".lob-flag");
		cSel.addEventListener("change", function () {
			var c = countryByName(cSel.value); if (!c) return;
			flag.textContent = flagEmoji(c[1]);
			var v = pInp.value.trim();
			if (!v || /^\+?\d{0,4}\s*$/.test(v)) pInp.value = "+" + c[2] + " ";
		});
		pInp.addEventListener("input", function () {
			var digits = pInp.value.replace(/[^\d]/g, "");
			if (!digits) return;
			var c = countryByDial(digits);
			if (c) { flag.textContent = flagEmoji(c[1]); cSel.value = c[0]; }
		});
	}
	function openModal() {
		var m = document.querySelector(".lob-modal"); if (!m) return;
		var likes = getLikes();
		var chips = m.querySelector(".lob-modal-chips");
		if (likes.length) {
			chips.hidden = false;
			chips.innerHTML = '<span class="lob-chips-label">Roses you love</span>' +
				likes.map(function (x) { return '<span class="lob-chip">' + esc(x.name) + "</span>"; }).join("");
		} else { chips.hidden = true; chips.innerHTML = ""; }
		m.querySelector(".lob-eoi").hidden = false;
		m.querySelector(".lob-modal-done").hidden = true;
		m.hidden = false; document.body.classList.add("lob-locked");
	}
	function closeModal() { var m = document.querySelector(".lob-modal"); if (m) { m.hidden = true; document.body.classList.remove("lob-locked"); } }

	function submitEoi(e) {
		e.preventDefault();
		var form = e.currentTarget, m = form.closest(".lob-modal");
		var status = form.querySelector(".lob-eoi-status");
		var btn = form.querySelector(".lob-eoi-submit");
		var payload = {
			first_name: form.first_name.value.trim(),
			last_name: form.last_name.value.trim(),
			email_id: form.email_id.value.trim(),
			mobile_no: form.mobile_no.value.trim(),
			country: form.country ? form.country.value : "",
			custom_request: form.custom_request.value,
			message: form.message.value.trim(),
			flowers: getLikes().map(function (x) { return x.name; })
		};
		function fail(msg, field) {
			status.textContent = msg; status.className = "lob-eoi-status err";
			if (field && field.focus) field.focus();
			return false;
		}
		// Tell them exactly what's missing, and jump them to it.
		var missing = [];
		if (!payload.first_name) missing.push("first name");
		if (!payload.last_name) missing.push("last name");
		if (!payload.email_id) missing.push("email");
		if (!payload.mobile_no) missing.push("phone number");
		if (missing.length) {
			var list = missing.length === 1 ? missing[0]
				: missing.slice(0, -1).join(", ") + " and " + missing[missing.length - 1];
			var f = !payload.first_name ? form.first_name : !payload.last_name ? form.last_name
				: !payload.email_id ? form.email_id : form.mobile_no;
			return fail("Please add your " + list + " so we can reach you.", f);
		}
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email_id)) {
			return fail("That email address doesn't look complete — please double-check it (e.g. name@example.com).", form.email_id);
		}
		if (payload.mobile_no.replace(/[^\d]/g, "").length < 7) {
			return fail("Please enter a phone number we can reach you on, including the country code.", form.mobile_no);
		}
		btn.disabled = true; status.textContent = "Sending…"; status.className = "lob-eoi-status";
		var token = (document.querySelector('meta[name="csrf_token"]') || {}).content || "";
		fetch("/api/method/upande_scp.www.library_of_blooms.index.submit_interest", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Frappe-CSRF-Token": token, "X-Requested-With": "XMLHttpRequest" },
			body: JSON.stringify({ payload: JSON.stringify(payload) })
		}).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
		.then(function (res) {
			if (res.ok && res.j && res.j.message && res.j.message.ok) {
				m.querySelector(".lob-eoi").hidden = true;
				m.querySelector(".lob-modal-done").hidden = false;
				saveLikes([]); syncLikeUI();
			} else {
				status.textContent = "We couldn't send your details just now — please check everything looks right and try again. If it keeps happening, email us at hello@karenroses.com.";
				status.className = "lob-eoi-status err"; btn.disabled = false;
			}
		}).catch(function () {
			status.textContent = "We couldn't reach the farm just now — please check your internet connection and try again.";
			status.className = "lob-eoi-status err"; btn.disabled = false;
		});
	}

	// ── Keep all like UI in sync ──
	function syncLikeUI() {
		var n = getLikes().length;
		var badge = document.querySelector(".lob-nav-badge");
		if (badge) { badge.innerHTML = n > 0 ? String(n) : "♥"; badge.classList.toggle("is-empty", n === 0); }
		if (n > 0) hideHint();
		var count = document.querySelector(".lob-nav-count"); if (count) count.textContent = n;
		document.querySelectorAll(".lob-like").forEach(function (b) {
			var on = likedSlug(b.getAttribute("data-slug"));
			b.classList.toggle("is-liked", on); b.setAttribute("aria-pressed", on ? "true" : "false");
		});
		var gathered = document.querySelector(".lob-gathered-count");
		if (gathered) gathered.textContent = n;
		var plural = document.querySelector(".lob-gathered-s");
		if (plural) plural.style.display = n === 1 ? "none" : "";
		var gp = document.querySelector(".lob-gathered");
		if (gp) gp.classList.toggle("has-blooms", n > 0);
		if (document.querySelector(".lob-tray") && !document.querySelector(".lob-tray").hidden) renderTray();
	}

	function prefersReduce() {
		return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	}

	// ── Motion ─────────────────────────────────────────────────────────
	function initMotion() {
		var reduce = window.matchMedia &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;

		// Reveal on scroll (works without GSAP; CSS does the easing)
		var reveals = document.querySelectorAll("[data-reveal]");
		if (reduce || !("IntersectionObserver" in window)) {
			reveals.forEach(function (n) { n.classList.add("is-in"); });
		} else {
			var io = new IntersectionObserver(function (entries) {
				entries.forEach(function (e) {
					if (!e.isIntersecting) return;
					var node = e.target;
					var d = parseFloat(node.getAttribute("data-d") || "0");
					node.style.transitionDelay = (d * 0.09) + "s";
					node.classList.add("is-in");
					io.unobserve(node);
				});
			}, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 });
			reveals.forEach(function (n) { io.observe(n); });
		}

		// Progress hairline
		var bar = document.querySelector(".lob-progress span");
		function onScroll() {
			var h = document.documentElement;
			var p = h.scrollTop / (h.scrollHeight - h.clientHeight || 1);
			if (bar) bar.style.width = (p * 100).toFixed(2) + "%";
		}
		window.addEventListener("scroll", onScroll, { passive: true });
		onScroll();

		// Scroll cue
		var cue = document.querySelector(".lob-scroll-cue");
		if (cue) cue.addEventListener("click", function () {
			var t = document.getElementById("farm");
			if (t) t.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
		});

		if (reduce || !window.gsap) return;

		var gsap = window.gsap;
		gsap.registerPlugin(window.ScrollTrigger);

		// Cover gold frame draws in
		gsap.to(".lob-frame-rect", {
			strokeDashoffset: 0, duration: 2.2, ease: "power2.inOut", delay: 0.25, stagger: 0.15
		});

		// Gentle parallax on framed imagery
		gsap.utils.toArray("[data-parallax]").forEach(function (node) {
			gsap.fromTo(node, { yPercent: -8 }, {
				yPercent: 8, ease: "none",
				scrollTrigger: { trigger: node, start: "top bottom", end: "bottom top", scrub: true }
			});
		});

		// Closing photo slow drift
		gsap.fromTo(".lob-closing-photo", { yPercent: -6 }, {
			yPercent: 6, ease: "none",
			scrollTrigger: { trigger: ".lob-closing", start: "top bottom", end: "bottom top", scrub: true }
		});

		// Atmosphere colour flows between sections
		var atmosphere = document.querySelector(".lob-atmosphere");
		document.querySelectorAll("[data-bg]").forEach(function (sec) {
			var col = sec.getAttribute("data-bg");
			window.ScrollTrigger.create({
				trigger: sec, start: "top 60%", end: "bottom 40%",
				onToggle: function (self) {
					if (self.isActive) gsap.to(atmosphere, { backgroundColor: col, duration: 0.9, overwrite: "auto" });
				}
			});
		});
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", mount);
	} else {
		mount();
	}
})();
