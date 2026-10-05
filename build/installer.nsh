; HydroRecon's NSIS include. Additive (`nsis.include`), never `script:` — the
; stock electron-builder installer is kept whole and this only adds to it.
;
; Two jobs:
;
; 1. THE DARK SKIN. MUI_BGCOLOR / MUI_TEXTCOLOR turn the Welcome and Finish
;    pages and the header strip to the app's ink so the bitmaps in build/ sit on
;    their own ground instead of floating on wizard white. Colours are
;    src/app.css's --color-bg and its text; keep them in step with
;    build/make-brand-art.py, which draws the bitmaps.
;
; 2. THE WELCOME PAGE. electron-builder's assisted installer has no Welcome
;    page at all — it opens on the install page — so without this the sidebar
;    art is only ever seen on Finish.
;
; These defines live in customWelcomePage and NOT in customHeader. electron-
; builder inserts customHeader after MUI2's pages are already declared, where
; a !define collides with MUI's own defaults and kills the build;
; customWelcomePage is inserted as the very first page macro, so defines at its
; top are the first interface settings MUI2 sees.
;
; Deliberately not touched: the Finish page (re-declaring MUI_PAGE_FINISH from
; an include is a known page-ordering bug) and the install-progress body, which
; stays system-coloured — skinning it needs per-control hacks that break across
; Windows versions. Also not possible, so nobody spends a day on it: custom
; fonts (system Segoe UI only; the Geist wordmark is baked into the bitmaps)
; and rounded corners.
!macro customWelcomePage
  !define MUI_BGCOLOR 0e0f11
  !define MUI_TEXTCOLOR ffffff
  !define MUI_WELCOMEPAGE_TITLE "HydroRecon"
  !define MUI_WELCOMEPAGE_TEXT "Run-of-river hydropower screening for Nepal.$\r$\n$\r$\nClick a river, get a scheme: capacity, energy, head and design flow, with the measured error bar on every number and every source named.$\r$\n$\r$\nScreening, not feasibility. It replaces the first two weeks of a study, not the study.$\r$\n$\r$\nClick Next to choose where to install it."
  !insertmacro MUI_PAGE_WELCOME
!macroend
