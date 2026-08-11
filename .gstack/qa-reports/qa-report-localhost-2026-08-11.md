# QA Report: RiverPower

| Field | Value |
|-------|-------|
| **Date** | 2026-08-11 |
| **URL** | `http://127.0.0.1:5174/` |
| **Branch** | `master` |
| **Commit** | `807af56` (application) + `3f1781b` (static hosting entry) |
| **PR** | — |
| **Tier** | Standard, with before/after repair pass |
| **Scope** | Full single-page app; desktop and mobile; river discovery, direct click, intake, powerhouse, upstream-service failure, and map performance |
| **Duration** | ~50 minutes |
| **Pages visited** | 1 SPA, 8 interaction states |
| **Screenshots** | 14 |
| **Framework** | React 19 + Vite 6 + MapLibre GL 5 |
| **Index** | [All QA runs](./index.md) |

## Health Score: 99/100

| Category | Score |
|----------|-------|
| Console | 100 |
| Links | 100 |
| Visual | 100 |
| Functional | 100 |
| UX | 100 |
| Performance | 97 |
| Content | 100 |
| Accessibility | 97 |

The remaining points reflect the intentionally large MapLibre runtime and the absence of a full
screen-reader audit. Fresh-session browser logs contained no errors or warnings.

## Top 3 Residual Risks

1. **Public hydrology availability** — Open-Meteo can still be unavailable or quota-limited; the app now cools down and falls back instead of retrying or failing the workflow.
2. **Model resolution** — GloFAS resolves the largest river in a roughly 5 km cell, so it is a hydrology estimate, not the visual river geometry or a measured gauge.
3. **Map runtime size** — MapLibre remains 284.6 KB gzip, although it is isolated in a long-lived cacheable chunk and is required above the fold.

## Console Health

| Error | Count | First seen |
|-------|-------|------------|
| Current uncaught errors | 0 | — |
| Current warnings | 0 | — |

The original missing-sprite warnings (`circle-11`, `wood-pattern`) were removed by the runtime
style-image fallback and did not recur in a clean browser tab.

## Summary

| Severity | Found | Remaining |
|----------|-------|-----------|
| Critical | 0 | 0 |
| High | 4 | 0 |
| Medium | 3 | 0 |
| Low | 1 | 0 |
| **Total** | **8** | **0** |

## Issues and Fixes

### ISSUE-001: River discovery exhausted the Flood API

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | functional |
| **Fix status** | verified |
| **Files changed** | `src/api.ts`, `src/App.tsx` |

The old view scan requested up to 100 locations and a year of discharge at once. In the reproduced
session it immediately returned a daily-limit response. Discovery now reads the bundled
HydroRIVERS network, makes zero Open-Meteo requests, applies the m³/s threshold locally, and places
every result on a river centerline.

**Before:** [Rate-limited scan](screenshots/baseline-scan.png)  
**After:** [Local river discovery](screenshots/redesign-river-discovery.png)

### ISSUE-002: The app silently analysed a different, larger river

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | functional |
| **Fix status** | verified |
| **Files changed** | `src/api.ts`, `src/App.tsx` |

The prior nearest-reach correction could move the hydrology context to a dominant channel while
leaving the visible marker at the clicked coordinate. The app now keeps the selected reach and, if
a larger channel is nearby, offers **Use the larger channel** with its exact mapped centerline point.

### ISSUE-003: Map clicks did not prove that the intake was on the visible river

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | ux |
| **Fix status** | verified |
| **Files changed** | `src/App.tsx` |

Direct clicks now query the rendered waterway geometry within a 16 px tolerance, calculate the
closest point on the chosen line segment, and place the marker there. Off-river clicks are rejected
with a useful zoom-and-click message.

**Before:** [Ambiguous river click](screenshots/baseline-river-click.png)  
**After:** [Marker on the mapped channel](screenshots/final-river-selection-loaded.png)

### ISSUE-004: Cross-border reaches appeared in Nepal results

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | functional |
| **Fix status** | verified |
| **Files changed** | `src/api.ts` |

The previous rectangle-based Nepal check admitted northern India and a full cross-border
HydroRIVERS reach. Candidate vertices and Nepal-only panels now use a conservative point-in-polygon
national outline. The reproduced Indian coordinate no longer scans as Nepal.

### ISSUE-005: Rate limiting appeared as a fatal analysis error

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | ux |
| **Fix status** | verified |
| **Files changed** | `src/api.ts`, `src/App.tsx` |

GloFAS requests are now quantized by their 0.05° model cell, coalesced while in flight, cached for
180 days, and paused according to `Retry-After` or the next UTC day. A stale record is usable during
a 429; otherwise the UI clearly shows the HydroRIVERS long-term mean and keeps rainfall, catchment,
terrain, infrastructure, licences, gauges, and seismic checks available.

### ISSUE-006: Detailed map interaction downloaded unnecessary DEM tiles

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | performance |
| **Fix status** | verified |
| **Files changed** | `src/App.tsx`, `scripts/perf.mjs`, `vite.config.ts` |

Hillshade is now basin-scale only and its raster source stops at zoom 12. In the existing 10-step
zoom-plus-pan benchmark, interaction traffic fell from 91 requests / 5,294 KB to 44 requests /
1,954 KB. React, MapLibre, and application code are emitted as separate cacheable chunks.

### ISSUE-007: The product hierarchy obscured the primary workflow

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | visual |
| **Fix status** | verified |
| **Files changed** | `src/App.tsx`, `src/styles.css`, `index.html` |

The page is now a map-first engineering workspace with a clear intake → powerhouse → review
sequence, river-region jump control, flow filter, local discovery summary, explicit provenance,
responsive mobile stacking, and high-contrast river styling.

**Before:** [Original desktop](screenshots/baseline-desktop.png)  
**After:** [Redesigned desktop](screenshots/final-desktop.png) and [mobile finder](screenshots/final-mobile-finder.png)

### ISSUE-008: Successful selection could retain stale off-river feedback

| Field | Value |
|-------|-------|
| **Severity** | low |
| **Category** | functional |
| **Fix status** | verified |
| **Files changed** | `src/App.tsx` |

The map listener previously triggered a status update from inside another state updater. A stable
intake reference now makes the transition deterministic: successful first and second clicks report
the intake and completed reach states respectively.

## Regression Tests

| Test | Status | Result |
|------|--------|--------|
| TypeScript strict check | passed | `npm run typecheck` |
| Hydrology/physics suite | passed | `npm run check` — 36/36 |
| Production build | passed | `npm run build` |
| Diff whitespace validation | passed | `git diff --check` |
| Desktop fresh load | passed | map-first workspace renders at 1440×900 |
| Mobile fresh load | passed | no horizontal overflow at 390×844 |
| Nepal jump + ≥2 m³/s scan | passed | local candidates returned without a Flood API call |
| Candidate selection | passed | marker visually aligned with river centerline |
| Off-river click | passed | rejected without changing the site |
| On-river click | passed | snapped to visible waterway and gave correct feedback |
| Second river click | passed | powerhouse placed and review step activated |
| Upstream daily-limit state | passed | neutral cooldown message plus HydroRIVERS fallback |
| Fresh browser console | passed | 0 errors, 0 warnings |
| Map interaction benchmark | passed | 44 requests / 1,954 KB |

## Ship Readiness

| Metric | Value |
|--------|-------|
| Health score | 76 → 99 (+23) |
| Issues found | 8 |
| Fixes applied | 8 verified |
| Deferred bugs | 0 |
| Known external constraint | Free Open-Meteo availability and quota |

**PR summary:** QA found 8 issues, fixed 8, and raised the health score from 76 to 99.
