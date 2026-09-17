# Poppins for the report emails

Two formats, two consumers:

- **`.woff2`** — served at `/assets/upande_scp/fonts/poppins-<weight>.woff2` and
  referenced by `@font-face` in the progress email. Apple Mail loads it; Gmail and
  Outlook strip `@font-face` and fall back to the stack in
  `progress_email_v2.FONT`. That is expected — the design is drawn to survive it.
- **`.ttf`** — for the PDF attachment. wkhtmltopdf (the PDF engine on a standard
  Frappe server) ignores `@font-face` entirely; it resolves families through
  fontconfig. So the faces must be installed on the server, once:

```bash
mkdir -p ~/.local/share/fonts
cp apps/upande_scp/upande_scp/public/fonts/poppins-*.ttf ~/.local/share/fonts/
fc-cache -f
fc-match Poppins          # must print poppins-400.ttf, not DejaVu
```

Without that install the PDF still renders — in the fallback face. A missing font
degrades the look, never the send.

Verify what a built PDF actually embedded:

```bash
bench --site <site> execute \
  upande_scp.serverscripts.reports.progress_email_v2.preview_pdf \
  --kwargs "{'target_date':'2026-07-07'}"
# → {"poppins": true, "fonts": ["Poppins-Bold", "Poppins-Regular", ...]}
```

Weights: wkhtmltopdf maps the family to regular and bold only, so the 500/600
weights in the design render as regular/bold in the PDF. The email, where the
webfont does load, gets all four.
