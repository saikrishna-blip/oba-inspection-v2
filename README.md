Lumio OBA Inspection Portal
Single-file web portal for IS 2500 Level G2 OBA batch inspection, backed by a
Google Apps Script / Google Sheets backend.
```
oba-inspection/
├── index.html                     the entire portal (HTML + CSS + JS, no build step)
├── apps-script/
│   └── Code.gs                    OPTIONAL hardened backend (drop-in replacement)
├── _validate.py                   structural + JS syntax validator
├── _ui_test.py                    headless-browser UI test suite (95 checks)
└── README.md
```
Deploying the front end
`index.html` is completely self-contained — no build, no dependencies, no CDN.
Publish it however you like:
GitHub Pages — enable Pages on `main` (root). The portal is served as-is.
Shared drive / USB — the file also works when opened directly (`file://`).
Any static host — S3, Netlify, nginx, an intranet share.
Only one file needs to be replaced. There are no assets to copy: the Lumio logo
is embedded as a single data URI.
First run
Open the portal. On first run it asks for your Apps Script Web App URL
(it must end in `/exec`). The URL is stored in the browser only.
Sign in with a username and password from your `Users` sheet.
“Explore with demo data” loads a fully interactive sample dataset with
no backend at all — useful for training and for previewing the interface.
Standards encoded in the portal
Rule	Value
Lot size	90 units
Sample size	13 units
Minor (aesthetic) acceptance	Ac ≤ 1
Major acceptance	Ac = 0
Major categories	General, Functional, Screen, Black dot
Black dot: not visible at 2 m → acceptable at any quantity · D ≤ 1.28 mm with
N ≤ 3 and DS ≥ 15 mm → OK · 1.28 < D ≤ 2.4 mm → Area A (N ≤ 1) / Area B (N ≤ 3) /
A+B (N ≤ 3) · D > 2.4 mm → fail.
Serial format: 15 digits — 4-digit model code, 4-digit production month
(`MMYY`), 7-digit sequence. Model codes: `1217` LH1G, `1218` LH3G, `1213` LH3G New.
Inspection workflow
Dashboard → pick an open lot → Inspect.
Capture the 13 serials. Three ways:
📷 Scan barcode — camera scanning (`Alt+S`). Uses the browser
`BarcodeDetector` API where available and falls back to manual entry.
⇥ Paste serials — paste a newline/comma separated list (`Alt+P`).
⚡ Autofill sequence — generate sequential serials for the empty rows.
Or just type: each field auto-advances on the 15th digit, and `Enter`/`F2`
validates and jumps to the next sample. `↑`/`↓` move between rows.
Flag defects with the Aes / Gen / Func / Scr toggles. The BD button
opens the black-dot panel (D, N, DS, area) and evaluates it live.
The footer shows live tallies and the lot verdict. Ctrl+Enter submits.
Submitted lots close, record FG quantity, and clear their local draft.
Drafts save automatically after every change. A refresh, a dropped
connection or an accidental back navigation never loses work — unfinished lots
appear at the top of the dashboard as resumable drafts.
Reporting
🖨 Report opens a print-ready sheet with four sections: executive summary,
batch/lot detail, defect analysis and an approval block. Use the browser's
Save as PDF.
⬇ CSV exports the lot table (UTF-8 with BOM, so Excel opens it cleanly).
📈 Analytics shows a defect Pareto with cumulative percentage, a defect
breakdown, and a batch yield comparison.
> Analytics and the defect section of the report need per-unit defect data,
> which only the hardened backend records. Until it is deployed they fall back
> to lot-level counts and local drafts, and the UI says so.
Keyboard shortcuts
Keys	Action
`Enter` / `F2`	Validate serial, advance to next sample
`↑` / `↓`	Move between serial fields
`Alt + S`	Barcode scanner
`Alt + P`	Paste a list of serials
`Ctrl + Enter`	Submit the lot
`?` in the header opens an in-app reference for all of the above.
Compatibility
The portal works unchanged against the existing Apps Script deployment.
Every action the previous version used is preserved verbatim — `login`,
`getBatches`, `getKits`, `createBatch`, `createKit`, `updateLot`, `deleteLot`,
`deleteBatch`, `addUser`, `checkSerial`, `submitLot` — including the legacy
`getKits`/`createKit` fallbacks.
Newer capabilities are feature-detected at runtime. If the backend does not
provide them, the related UI is hidden rather than shown broken.
Optional: hardened backend
`apps-script/Code.gs` is an optional drop-in replacement that fixes several
integrity and credential issues in the original backend. See
`apps-script/README-apps-script.md`.
Summary of what it adds: server-side verdict validation, salted password
hashing, expiring session tokens, global serial uniqueness, per-unit storage and
an audit trail.
You do not have to deploy it. Without it the portal runs in client-side
verdict mode and says so in a banner.
Tests
Three tools, all plain Python. Node.js is needed only by `_verify_render.py`.
```bash
python _validate.py       # tag balance, duplicate ids, JS syntax, encoding
python _verify_render.py  # renders a real sample row and asserts its structure
python _ui_test.py        # 95 behavioural checks, needs Chrome
```
`_validate.py` — static integrity of `index.html`: tag balance, missing
duplicate `id`s, that the single `<script>` block parses, and that no placeholder
or mojibake residue remains.
`_verify_render.py` — a regression guard that needs no browser. It executes
the portal's real `buildSampleRow()` in Node and asserts the structure it emits.
This exists because of a genuine bug: the sample row's `</div>` closes before
the black-dot panel opens, so the panel is a sibling of the row, not a
descendant. `refreshBdCell()` originally searched inside the row and silently
found nothing, so the panel's verdict never updated. The test fails loudly if
that structure ever changes or the lookup regresses.
`_ui_test.py` — the full behavioural suite. It builds a copy of `index.html`
with an assertion harness appended, runs it through headless Chrome, and reports
pass/fail per behaviour: every screen's rendering, the serial and black-dot rule
engines, verdict transitions (minor ≤ 1, major = 0), autofill, draft and session
persistence, accessibility basics and the mobile layout.
> **Environment note.** `_ui_test.py` needs a browser that can actually start.
> Under a restrictive sandbox Chrome may fail with
> `mojo platform_channel: Access is denied` — its multi-process architecture
> needs named pipes, which some sandboxes block. Run it from a normal shell.
> `_validate.py` and `_verify_render.py` have no such requirement.
The suite writes its scratch files to `_testrun/` inside this directory (not the
system temp directory) so it works under a workspace-confined sandbox. That
folder is disposable.
