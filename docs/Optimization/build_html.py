#!/usr/bin/env python3
"""Render dataload-architecture.md to a self-contained styled HTML page.

Re-run after editing the markdown:
    python3 docs/Optimization/build_html.py

Design notes
------------
* The monospace stack is deliberately SYSTEM-ONLY. The diagrams use box-drawing
  glyphs (─ │ ═ ╬ ► ★ ╳); a webfont missing any one of them substitutes a
  different-width glyph and every diagram loses its column alignment. System
  mono is what already renders these correctly in an editor.
* Code blocks containing box-drawing characters are classed as `.diagram` and
  get the panel treatment; genuine code/output blocks stay plain.
"""

import html
import re
import pathlib
import datetime

import markdown

HERE = pathlib.Path(__file__).parent
SRC = HERE / "dataload-architecture.md"
OUT = HERE / "dataload-architecture.html"

BOX = set("─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╬╫►◄▼▲★╳·")


def render_body(md_text: str) -> str:
    return markdown.markdown(
        md_text,
        extensions=["tables", "fenced_code", "attr_list", "sane_lists"],
        output_format="html5",
    )


def classify_pre(body: str) -> str:
    """Tag <pre> blocks that are diagrams, and colourise their markers."""

    def repl(m):
        inner = m.group(1)
        text = html.unescape(re.sub(r"<[^>]+>", "", inner))
        is_diagram = any(ch in BOX for ch in text)
        cls = "diagram" if is_diagram else "codeblock"
        label = "ARCHITECTURE VIEW" if is_diagram else "OUTPUT"
        if is_diagram:
            for ch, klass in (("★", "m-new"), ("╳", "m-del"), ("✓", "m-ok")):
                inner = inner.replace(ch, f'<span class="{klass}">{ch}</span>')
            inner = re.sub(r"(◄|►)", r'<span class="m-arrow">\1</span>', inner)
        return (
            f'<figure class="{cls}"><span class="blk-label">{label}</span>'
            f"<pre>{inner}</pre></figure>"
        )

    return re.sub(r"<pre><code[^>]*>(.*?)</code></pre>", repl, body, flags=re.S)


def mark_cells(body: str) -> str:
    """Colourise status glyphs inside table cells."""
    for ch, klass in (("✓", "m-ok"), ("╳", "m-del"), ("✗", "m-del"), ("★", "m-new")):
        body = body.replace(
            f"<td>{ch}</td>", f'<td class="ctr"><span class="{klass}">{ch}</span></td>'
        )
    body = re.sub(r"(<td[^>]*>)([^<]*?)(✓|╳|✗|★)", lambda m: m.group(1) + m.group(2) +
                  f'<span class="{"m-ok" if m.group(3)=="✓" else "m-new" if m.group(3)=="★" else "m-del"}">{m.group(3)}</span>', body)
    return body


def build_toc(body: str):
    """Slug every h2/h3, return (body_with_ids, toc_html)."""
    items = []

    def repl(m):
        level, text = m.group(1), m.group(2)
        plain = re.sub(r"<[^>]+>", "", text)
        slug = re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")
        items.append((level, slug, plain))
        return f'<h{level} id="{slug}">{text}</h{level}>'

    body = re.sub(r"<h([23])>(.*?)</h\1>", repl, body, flags=re.S)

    toc = ['<nav class="toc" aria-label="Contents"><p class="toc-h">Contents</p><ol>']
    for level, slug, plain in items:
        toc.append(f'<li class="l{level}"><a href="#{slug}">{html.escape(plain)}</a></li>')
    toc.append("</ol></nav>")
    return body, "".join(toc)


CSS = """
:root{
  --ink:#090d0f; --ink2:#0f1518; --ink3:#141c20;
  --paper:#e9e5dd; --dim:#98a3a7; --faint:#6b7679;
  --hot:#ff8f45; --cool:#63d2d9; --ok:#7ad98d; --bad:#ff6257; --new:#ffd166;
  --rule:rgba(233,229,221,.13); --rule2:rgba(233,229,221,.07);
  --mono:ui-monospace,"DejaVu Sans Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --serif:"Newsreader",Georgia,"Times New Roman",serif;
  --disp:"Bricolage Grotesque","Chivo",Helvetica,sans-serif;
  --measure:70ch;
}
[data-theme=light]{
  --ink:#f5f2ec; --ink2:#fffdf8; --ink3:#eae5db;
  --paper:#16191a; --dim:#4e585c; --faint:#78838700;
  --faint:#787f82;
  --hot:#b8480b; --cool:#0d6f78; --ok:#1c7a34; --bad:#b0271c; --new:#8a6200;
  --rule:rgba(22,25,26,.16); --rule2:rgba(22,25,26,.08);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:2rem}
body{
  margin:0; background:var(--ink); color:var(--paper);
  font-family:var(--serif); font-size:17.5px; line-height:1.62;
  font-variation-settings:"opsz" 16;
  -webkit-font-smoothing:antialiased;
}
body::before{ /* grain */
  content:"";position:fixed;inset:0;pointer-events:none;z-index:99;opacity:.035;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
}
.wrap{max-width:1180px;margin:0 auto;padding:0 clamp(1rem,4vw,3rem) 8rem}

/* ── masthead ─────────────────────────────────────────── */
header.mast{
  border-bottom:1px solid var(--rule); margin-bottom:3.5rem;
  padding:clamp(2.5rem,7vw,5rem) 0 2rem; position:relative;
}
header.mast::after{
  content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;
  background:linear-gradient(90deg,var(--hot),transparent 45%);
}
.eyebrow{
  font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--hot);margin:0 0 1.4rem;display:flex;gap:1.2rem;flex-wrap:wrap;align-items:center;
}
.eyebrow .dot{width:5px;height:5px;background:var(--hot);border-radius:50%;display:inline-block}
h1{
  font-family:var(--disp);font-weight:800;font-size:clamp(2.3rem,6.2vw,4.3rem);
  line-height:1.02;letter-spacing:-.032em;margin:0 0 1.5rem;max-width:16ch;
}
h1 em{font-style:normal;color:var(--hot)}
.standfirst{font-size:1.12rem;color:var(--dim);max-width:62ch;margin:0 0 2rem}
.facts{
  display:flex;flex-wrap:wrap;gap:0;border:1px solid var(--rule);
  font-family:var(--mono);font-size:12px;
}
.facts div{padding:.75rem 1.1rem;border-right:1px solid var(--rule);flex:1 1 auto}
.facts div:last-child{border-right:0}
.facts b{display:block;color:var(--faint);font-weight:400;font-size:10px;
  letter-spacing:.16em;text-transform:uppercase;margin-bottom:.3rem}
.facts span{color:var(--paper)}
.facts .hot span{color:var(--hot)}

/* ── layout ───────────────────────────────────────────── */
.cols{display:grid;grid-template-columns:1fr;gap:3rem}
@media(min-width:1080px){
  .cols{grid-template-columns:210px minmax(0,1fr);gap:4rem;align-items:start}
  .toc{position:sticky;top:2rem;max-height:88vh;overflow-y:auto}
}
.toc{font-family:var(--mono);font-size:11.5px;line-height:1.5}
.toc-h{color:var(--hot);letter-spacing:.2em;text-transform:uppercase;font-size:10px;
  margin:0 0 .9rem;padding-bottom:.6rem;border-bottom:1px solid var(--rule)}
.toc ol{list-style:none;margin:0;padding:0}
.toc li{margin:.1rem 0}
.toc li.l3{padding-left:1rem}
.toc a{color:var(--dim);text-decoration:none;display:block;padding:.28rem .4rem;
  border-left:1px solid transparent;transition:.16s}
.toc a:hover{color:var(--paper);background:var(--ink2);border-left-color:var(--hot)}
.toc a.on{color:var(--hot);border-left-color:var(--hot)}
@media(max-width:1079px){.toc{display:none}}

/* ── prose ────────────────────────────────────────────── */
main{min-width:0}
main > p, main > ul, main > ol, main > blockquote{max-width:var(--measure)}
h2{
  font-family:var(--disp);font-weight:800;font-size:clamp(1.55rem,3vw,2.15rem);
  letter-spacing:-.022em;line-height:1.14;margin:4.5rem 0 1.4rem;
  padding-top:1.6rem;border-top:1px solid var(--rule);position:relative;
}
h3{
  font-family:var(--disp);font-weight:700;font-size:1.16rem;letter-spacing:-.012em;
  margin:2.8rem 0 .9rem;color:var(--paper);
}
h3::before{content:"";display:inline-block;width:14px;height:2px;background:var(--hot);
  vertical-align:middle;margin-right:.6rem;transform:translateY(-2px)}
p{margin:0 0 1.15rem}
strong{font-weight:700;color:var(--paper)}
em{font-style:italic;color:var(--dim)}
a{color:var(--cool);text-decoration:none;border-bottom:1px solid var(--rule)}
a:hover{border-bottom-color:var(--cool)}
ul,ol{padding-left:1.3rem;margin:0 0 1.3rem}
li{margin:.42rem 0}
li::marker{color:var(--hot)}
blockquote{
  margin:1.6rem 0;padding:.2rem 0 .2rem 1.4rem;border-left:2px solid var(--hot);
  color:var(--dim);font-style:italic;
}
del{color:var(--faint);text-decoration-color:var(--bad)}
hr{border:0;border-top:1px solid var(--rule2);margin:3rem 0}
code{
  font-family:var(--mono);font-size:.83em;background:var(--ink3);
  padding:.13em .38em;border-radius:2px;color:var(--cool);
  border:1px solid var(--rule2);
}
h2 code,h3 code{font-size:.8em}

/* ── figures: diagrams + code ─────────────────────────── */
figure{margin:1.9rem 0;position:relative;background:var(--ink2);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
figure.diagram{background:
  linear-gradient(var(--ink2),var(--ink2)) padding-box,
  linear-gradient(135deg,rgba(99,210,217,.34),rgba(255,143,69,.22)) border-box;
  border:1px solid transparent;}
.blk-label{
  display:block;font-family:var(--mono);font-size:9.5px;letter-spacing:.2em;
  color:var(--faint);padding:.6rem .95rem .1rem;text-transform:uppercase;
}
figure.diagram .blk-label{color:var(--cool)}
figure pre{
  margin:0;padding:.5rem .95rem 1.05rem;overflow-x:auto;
  font-family:var(--mono);font-size:12.6px;line-height:1.44;
  color:var(--dim);white-space:pre;tab-size:2;
  font-variant-ligatures:none;
}
figure.diagram pre{color:#a9c4c7;font-size:12.9px}
figure pre::-webkit-scrollbar{height:7px}
figure pre::-webkit-scrollbar-thumb{background:var(--rule);border-radius:4px}
.m-new{color:var(--new);font-weight:700}
.m-del{color:var(--bad);font-weight:700}
.m-ok{color:var(--ok);font-weight:700}
.m-arrow{color:var(--hot)}

/* ── tables ───────────────────────────────────────────── */
.tw{overflow-x:auto;margin:1.9rem 0;border:1px solid var(--rule);border-radius:3px}
table{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:12.6px;
  line-height:1.45;background:var(--ink2)}
thead th{
  text-align:left;font-weight:400;color:var(--hot);background:var(--ink3);
  font-size:9.8px;letter-spacing:.15em;text-transform:uppercase;
  padding:.72rem .85rem;border-bottom:1px solid var(--rule);white-space:nowrap;
}
td{padding:.6rem .85rem;border-bottom:1px solid var(--rule2);color:var(--dim);
  vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--ink3)}
td strong{color:var(--hot);font-weight:700}
td code{background:transparent;border:0;padding:0;color:var(--cool)}
td.ctr{text-align:center}
table em{color:var(--faint)}

/* ── controls ─────────────────────────────────────────── */
.ctl{position:fixed;right:1rem;bottom:1rem;z-index:100;display:flex;gap:.4rem}
.ctl button{
  font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  background:var(--ink2);color:var(--dim);border:1px solid var(--rule);
  padding:.55rem .8rem;border-radius:2px;cursor:pointer;transition:.16s;
}
.ctl button:hover{color:var(--hot);border-color:var(--hot)}

footer{margin-top:5rem;padding-top:1.6rem;border-top:1px solid var(--rule);
  font-family:var(--mono);font-size:11px;color:var(--faint);
  display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}

/* ── reveal ───────────────────────────────────────────── */
@media(prefers-reduced-motion:no-preference){
  main > h2,main > figure,main > .tw{animation:rise .5s cubic-bezier(.2,.7,.3,1) both}
  @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
}

@media print{
  :root{--ink:#fff;--ink2:#fff;--ink3:#f4f2ee;--paper:#000;--dim:#222;--rule:#bbb}
  body::before,.ctl,.toc{display:none}
  .cols{grid-template-columns:1fr}
  figure,.tw{break-inside:avoid}
  h2{break-after:avoid}
}
"""

JS = """
const root=document.documentElement;
const saved=localStorage.getItem('dl-theme');
if(saved) root.setAttribute('data-theme',saved);
document.getElementById('theme').onclick=()=>{
  const next=root.getAttribute('data-theme')==='light'?'dark':'light';
  root.setAttribute('data-theme',next);localStorage.setItem('dl-theme',next);
};
document.getElementById('print').onclick=()=>window.print();
const links=[...document.querySelectorAll('.toc a')];
const map=new Map(links.map(a=>[a.getAttribute('href').slice(1),a]));
const obs=new IntersectionObserver(es=>{
  es.forEach(e=>{if(e.isIntersecting){
    links.forEach(a=>a.classList.remove('on'));
    const a=map.get(e.target.id); if(a){a.classList.add('on');}
  }});
},{rootMargin:'0px 0px -75% 0px'});
document.querySelectorAll('h2[id],h3[id]').forEach(h=>obs.observe(h));
"""


def main():
    md_text = SRC.read_text(encoding="utf-8")
    body = render_body(md_text)
    body = classify_pre(body)
    body = mark_cells(body)
    body, toc = build_toc(body)
    body = body.replace("<table>", '<div class="tw"><table>').replace(
        "</table>", "</table></div>"
    )

    # Split the leading title + metadata off the rendered body.
    body = re.sub(r"^\s*<h1>.*?</h1>", "", body, flags=re.S)
    first_hr = body.find("<hr />")
    intro, rest = (body[:first_hr], body[first_hr:]) if first_hr > -1 else ("", body)
    intro_txt = re.sub(r"<[^>]+>", " ", intro)
    intro_txt = re.sub(r"\s+", " ", intro_txt).strip()

    stamp = datetime.date.today().isoformat()
    page = f"""<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Data bridge — options paper · upande_scp</title>
<meta name="description" content="Measured options paper on speeding up the SCP data bridge: sectional loading, indexes, Redis, live sync.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,400&display=swap" rel="stylesheet">
<style>{CSS}</style>
</head>
<body>
<div class="wrap">

<header class="mast">
  <p class="eyebrow"><span class="dot"></span> Options paper &nbsp;·&nbsp; not a spec
     <span>upande_scp</span><span>rendered {stamp}</span></p>
  <h1>Making the data <em>bridge</em> fast</h1>
  <p class="standfirst">{html.escape(intro_txt)}</p>
  <div class="facts">
    <div class="hot"><b>One week, today</b><span>83.5 MB · uncompressed</span></div>
    <div class="hot"><b>After A2</b><span>~80 KB</span></div>
    <div><b>Measured on</b><span>kaitet.local · 297 131 entries</span></div>
    <div><b>Target scale</b><span>30M – 100M</span></div>
  </div>
</header>

<div class="cols">
  {toc}
  <main>{rest}</main>
</div>

<footer>
  <span>upande_scp · docs/Optimization/dataload-architecture.md</span>
  <span>Figures measured on kaitet.local unless marked projected</span>
</footer>
</div>
<div class="ctl">
  <button id="theme">Light / Dark</button>
  <button id="print">Print</button>
</div>
<script>{JS}</script>
</body>
</html>"""
    OUT.write_text(page, encoding="utf-8")
    print(f"wrote {OUT}  ({len(page)/1024:.1f} KB)")


if __name__ == "__main__":
    main()
