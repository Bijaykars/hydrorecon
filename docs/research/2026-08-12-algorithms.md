# Algorithm & prior-art research — verified 2026-08-12

Items 1–3 researched by cloning the repos and reading source; 4–10 from primary web sources/PDFs.
Decisions distilled in `plan.md` §5 / §10.3. "Could not verify" list at the end.

## 1. GRASS r.green.hydro (GPL-2.0+ — reimplement from algorithm, don't translate code)

`OSGeo/grass-addons`, `src/raster/r.green/r.green.hydro/`.

**r.green.hydro.optimal** — intake/outlet search:
- Samples each river line at vertices: cumulative distance `prog[i]`, DEM elevation `h[i]`,
  discharge `q[i]`; builds 1-D interpolants `h(s)`, `q(s)`.
- Decision variables `x = [s, delta]` (intake chainage, plant length).
- Objective: maximize `f = [h(s) − h(s+delta)] · q(s)` — discharge at intake only, no losses.
- Power: `P = Σ (z_in − z_out) · Q · 9.810 · η` (kW).
- Constraints: `len_min ≤ delta ≤ len_plant` (defaults 10 m / 10 km); minimum spacing between
  plants; `P < p_min` (10 kW) discarded; recursion cap 100.
- Search: plain brute-force grid (`scipy.optimize.brute`, ~20 pts/dim, no polish).
- Cap mode: if `p_max` given, find the shortest `delta` reaching it (10 m grid + root find).
- Recursive tiling: after placing a plant, recurse on upstream & downstream remainders → whole
  river fills with plants.

**r.green.hydro.structure** — channel/penstock derivation:
- Contour line at intake elevation, split at intake into left/right branches (clipped to 3× the
  straight intake–outlet distance).
- **Channel = contour segment from intake to the contour point closest to the outlet**
  (near-zero head loss); **penstock = straight line from that point down to the outlet.**

Port judgment: very portable (~200 lines interp + grid search + root find; contour tracer +
point-to-polyline distance). Our engine improves it cheaply: subtract losses inside the search,
add residual flow, families, Pareto.

## 2. HydroGenerate (INL, **BSD-3-Clause** — port directly) — turbine typing + efficiency

`IdahoLabResearch/HydroGenerate`, `turbine_calculation.py`.

**Turbine typing:** point-in-polygon in (Q m³/s, H m); ties → nearest centroid. Exact vertices:
- Pelton: (1,50),(1,1000),(20,1000),(60,500),(50,400),(1,50)
- Turgo: (1,50),(1,260),(10,50),(1,50)
- Francis: (1,50),(5,10),(200,10),(900,15),(900,80),(100,700),(6,700),(1,50)
- Kaplan: (1,1),(1,20),(9,80),(175,80),(1000,15),(60,1),(1,1)
- Crossflow: (1,4),(1,100),(10,10),(10,4),(1,4)

**Efficiency curves** (RETScreen/CANMET 2004 correlations; `Rm` design coefficient default 4.5):
- Reaction runner diameter: `d = k·Qd^0.473`, k = 0.46 (Qd ≤ 23) else 0.41.
- **Francis:** `nq = 600·H^-0.5`; `e_nq = ((nq−56)/256)²`; `e_d = (0.081+e_nq)(1−0.789·d^-0.2)`;
  `e_p = (0.919 − e_nq + e_d) − 0.0305 + 0.005·Rm`; `Qp = 0.65·Qd·nq^0.05`;
  `ep_ = 0.0072·nq^0.4`; `e_r = (1−ep_)·e_p`.
  Below peak: `e = [1 − 1.25((Qp−Q)/Qp)^(3.94−0.0195·nq)]·e_p` (≥0).
  Above peak (RETScreen published form): `e = e_p − ((Q−Qp)/(Qd−Qp))²·(e_p−e_r)`.
  ⚠ HydroGenerate squares only the denominator — probable transcription bug; **use the published
  form in our port** and note the deviation.
- **Kaplan:** `nq = 800·H^-0.5`; `e_nq = ((nq−170)/700)²`; `e_d = (0.095+e_nq)(1−0.789·d^-0.2)`;
  `e_p = (0.905 − e_nq + e_d) − 0.0305 + 0.005·Rm`; `Qp = 0.75·Qd`;
  `e = (1 − 3.5((Qp−Q)/Qp)^6)·e_p`.
- **Propeller:** `e_p` as Kaplan; `Qp = Qd`; `e = (1 − 1.25((Qp−Q)/Qp)^1.13)·e_p`.
- **Pelton** (j jets, default 3): `n = 31(H·Qd/j)^0.5` rpm; `d = 49.4·H^0.5·j^0.02/n`;
  `e_p = 0.864·d^0.04`; `Qp = (0.662+0.001j)·Qd`;
  `e = [1 − (1.31+0.025j)(|Qp−Q|/Qp)^(5.6+0.4j)]·e_p`.
- **Turgo:** Pelton − 0.03 (≥0).
- **Crossflow:** `e = 0.79 − 0.15·(Qd−Q)/Qd − 1.37·((Qd−Q)/Qd)^14`
  ⚠ HydroGenerate divides the last term by `Q` — second probable bug; use `/Qd`.
- Generator efficiency default ~0.98. Design flow default = 30% exceedance from a 101-point FDC.

## 3. OpenHPL (MPL-2.0 — equation reference only)

- **fDarcy(Re, D, ε):** laminar `64/Re` (Re ≤ 2100); turbulent Swamee–Jain
  `f = [2·log10(ε/(3.7D) + 5.74/Re^0.9)]^-2` (Re ≥ 2300); cubic bridge 2100–2300.
- **Rigid water column** (mass-oscillation studies): one ODE per pipe:
  `L·d(ṁ)/dt = A(p_in + ρgH − p_out) − F_f`, `F_f = (π/8)·f_D·ρ·L·D·v·|v|`.
- **Surge tank:** `dm/dt = ρV̇`; `d(mv)/dt = ṁv + F_p − F_f − F_g` with `m = ρAh/cosθ`;
  variants: open, air-cushion (polytropic `p = p₀((L−l₀)/(L−l))^γ`), sharp orifice, throttle.
- **Elastic water hammer:** their `PenstockKP` uses Kurganov–Petrova 2007 FV; default effective
  wave speed a = 1000 m/s. For us: use MOC instead (item 6) — simpler imperatively, industry standard.

## 4. 2D local-inertial shallow water (Bates 2010 / de Almeida 2012)

Cross-verified against LISFLOOD-FP 8.0 paper (GMD 14:3577, open) and Wflow.jl docs:

- Face flux: `q^{n+1} = [q̂ − g·h_f·(dt/dx)·Δη] / [1 + g·dt·n²·|q| / h_f^{7/3}]`
- θ-weighting: `q̂ = θ·q_{i-1/2} + ((1−θ)/2)(q_{i-3/2} + q_{i+1/2})`, θ ≈ 0.7–0.9 (θ=1 → Bates ACC)
- Face depth: `h_f = max(η_L, η_R) − max(z_L, z_R)`; dry threshold ~1e-3 m → q = 0
- Continuity: `h^{n+1} = h^n + (dt/dx)·(Σq_in − Σq_out)`
- CFL: `dt = α·dx/√(g·h_max)`, α ≈ 0.2–0.7

**No JS/TS local-inertial implementation exists** (searched hard). Verdict: 512² easily feasible
(even a scalar worker does 50–100 steps/s; GPU thousands). Plan: write the ~150-line WGSL/GLSL
kernel fresh from the equations (no license entanglement); borrow ping-pong/render plumbing from
aeplay/WebFlood (MIT); validate against Wflow.jl (MIT) on a synthetic dam-break.

## 5. Watershed delineation / HydroBASINS (license: free incl. commercial, cite Lehner & Grill 2013)

- **Navigate by `NEXT_DOWN`** (HYBAS_ID of downstream polygon; 0 = terminal). Upstream set =
  transitive closure over reversed NEXT_DOWN. **Pfafstetter arithmetic is NOT reliable** in
  HydroBASINS (manual seeding at L1–3, "0" digits = skipped subdivisions, coastal lumping,
  endorheic quirks — cut virtual links where `ENDO = 2 AND NEXT_DOWN > 0`).
- `SORT` is ordered downstream→upstream — one reverse sweep computes any upstream accumulation
  without recursion. `UP_AREA`, `DIST_MAIN`, `MAIN_BAS` precomputed.
- Level-12: global 1.0 M polygons, avg 130.6 km². Nepal ≈ 1,100–1,200 polygons; window incl.
  transboundary Karnali/Gandaki/Koshi headwaters ≈ 3,000–4,000 → a few MB simplified. (Exact
  count pending the actual `hybas_as_lev12_v1c` download.)
- JS D8 prior art: uihilab/watershed-delineation (GPL-3, the only dedicated lib); offline
  alternative pysheds (GPL-3) / WhiteboxTools (MIT, WASM-compilable).

## 6. Water hammer — Joukowsky first cut + minimal MOC

- **Joukowsky:** `Δp = ρ·a·ΔV` (`Δh = a·ΔV/g`); wave speed
  `a = sqrt((K/ρ) / (1 + (K/E)(D/e)·c₁))`, K ≈ 2.1 GPa; steel penstock a ≈ 900–1200 m/s.
  Valid only for closure `t_c < 2L/a`; else **Michaud**: `Δh ≈ 2·L·V₀/(g·t_c)`.
  Ignores friction, packing, valve law, surge-tank interaction, column separation → MOC.
- **MOC** (verified via TSNet docs): characteristics along `dx/dt = ±a`;
  grid `dx = L/N`, `dt = dx/a` (Courant exactly 1); interior node solves C+/C− pair:
  `C±: (V_i − V_{i∓1}) ± (g/a)(H_i − H_{i∓1}) + (f·dt/2D)·V_{i∓1}|V_{i∓1}| ± (g·dt/a)·V_{i∓1}·sinα = 0`
  Boundaries: reservoir (H fixed + C−), valve (orifice law `Q = C_d·A(τ(t))·√(2gH)` + C+),
  surge tank (level ODE), junction (equal H, ΣQ = 0).
  Reference implementation: **TSNet (MIT)** — right module template (steady init → per-step
  boundary + interior sweep). Our topology is fixed (reservoir–penstock–turbine valve): ~200
  lines TS, ms-fast in a worker.

## 7. Turbine application chart

- Fill regions: HydroGenerate polygons (item 2, BSD-3).
- Cross-check overlays from **ESHA 2004** ch. 6: head ranges (Kaplan 2–40 m, Francis 25–350,
  Pelton 50–1300, Crossflow 5–200, Turgo 50–250); specific speed `n_QE = n·Q^0.5/E^0.75` with
  correlations Pelton-1jet `0.0859/Hn^0.243`, Francis `1.924/Hn^0.512`, Kaplan `2.294/Hn^0.486`,
  Propeller `2.716/Hn^0.5`, Bulb `1.528/Hn^0.2837`; ranges Pelton-1jet 0.005–0.025 (n jets ×√n),
  Francis 0.05–0.33, Kaplan family 0.19–1.55. Best efficiencies (Table 6.7): Kaplan 0.91/0.93
  (single/double-reg), Francis 0.94, Pelton 0.89–0.90, Turgo 0.85.

## 8. Economic penstock diameter

- **ESHA 2004 default** (limit friction loss to 4% of gross head, Manning n):
  `D = 2.69·(n²·Q²·L/H)^0.1875` (worked example: Q=3, H=85, L=173, n=0.012 → 0.88 m).
- **Ludin–Bondschu:** H ≤ 100 m: `D = (0.05·Q³)^(1/7)`; H > 100 m: `D = (5.2·Q³/H)^(1/7)`;
  check V ≲ 6 m/s.
- **Velocity-limit ("Sarkaria" small-hydro form):** `D = 3.55·[Q²/(2gH)]^0.25`
  (≡ fixing V = 0.125·√(2gH), USBR 1961).
- Refined mode: D-sweep minimizing PV(lost energy) + steel cost (Colebrook loss per D).

## 9. Nepal costs & PPA (verified Mar/Jun 2026 sources: CARE Ratings Nepal, ICRA Nepal, IPPAN)

- **PPA (ROR ≤ 100 MW):** wet NPR 4.80/kWh, dry NPR 8.40/kWh (PROR dry-peak 8.50);
  **escalation 3% simple × 8 annual**, from 12 mo after COD (COD delay 6–18 mo → 7 escalations).
  Season by vintage: newer PPAs wet = Jun 1–Nov 30, dry = Dec 1–May 31; older = mid-Apr–mid-Dec /
  mid-Dec–mid-Apr. Take-or-pay except ~10% of wet contract energy (take-and-pay). Term 30 yr.
  Newer PPAs require ≥ ~30% dry-season energy share. Tax holiday 100%×10 yr + 50%×5 yr.
- **CAPEX band (current private ROR):** **NPR ~170–240 Mn/MW (≈ USD 1.25–1.8 M/MW)** —
  Upper Marshyangdi 102 MW: NPR 209.8 Mn/MW; ICRA-rated smalls 167–239 Mn/MW. NEA fleet avg
  179.9 Mn/MW (outliers Chameliya 533, Kulekhani-III 331). Soft costs: survey/study ≈ 1.0 Mn/MW;
  cumulative pre-construction ≈ 37 Mn/MW. Debt:equity 70–75 : 25–30.
- Global sanity: IRENA 2023 — global weighted avg USD 3,053/kW (2022), LCOE $0.057/kWh.
- **Gap:** no public component-level unit-rate breakdown found (tunnel per-m, E&M curves) —
  candidate papers 403-blocked. Ship editable % splits + per-MW band, all `assumed`-labelled.

## 10. Cesium underground mode (verified vs ref docs + PRs #8726/#8811)

- `scene.globe.translucency`: `.enabled`, `.frontFaceAlpha(±ByDistance)`, `.backFaceAlpha(±ByDistance)`,
  `.rectangle` (localize translucency to the project area).
- `scene.globe.undergroundColor` + `undergroundColorAlphaByDistance`; `depthTestAgainstTerrain`;
  `screenSpaceCameraController.enableCollisionDetection = false` to go subsurface.
- Skirts auto-hidden and backface culling disabled when underground/translucent.
- **Gotchas:** ground-clamped geometry cannot go underground — use absolute-height
  `PolylineGeometry` / `PolylineVolumeGeometry` (tubes) / `CorridorGeometry`. Recipe for
  "see the penstock through the hillside": translucency on + `frontFaceAlpha(ByDistance)` +
  `depthTestAgainstTerrain = true`. Cheap alternative: `depthFailMaterial` (x-ray style).
  Known artifacts: billboard/label ordering, water tiles write depth, shadows disabled,
  no underground fog, 2D-morph artifacts.

## Could NOT verify

1. Sarkaria's original P/H-based coefficients (paywalled) — only the velocity form verified.
2. Exact HydroBASINS polygon count for the concrete Nepal window (estimated from avg area).
3. Whether the two HydroGenerate deviations are intentional (CANMET source PDF not fetched) —
   treated as bugs, published RETScreen forms used.
4. Ossberger's official crossflow envelope — ESHA 5–200 m range stands in.
5. Component-level Nepali unit costs (candidate papers 403-blocked).
6. `pickTranslucentDepth` exact requirement for picking on translucent globe.
7. de Almeida 2012 original (paywalled) — θ-scheme cross-checked via two open sources instead.

## Primary sources

OSGeo/grass-addons (GPL-2+) · IdahoLabResearch/HydroGenerate (BSD-3) · OpenSimHub/OpenHPL
(MPL-2.0) · GMD 14:3577 (LISFLOOD-FP 8.0) · Deltares/Wflow.jl (MIT) · aeplay/WebFlood (MIT) ·
uihilab/watershed-delineation (GPL-3) · HydroBASINS TechDoc v1.c · glorialulu/TSNet (MIT) ·
ESHA Guide 2004 · ITU lecture notes (Bulu) · CARE Ratings Nepal · ICRA Nepal · IPPAN 2025/26 ·
IRENA 2023 · CesiumGS/cesium PRs #8726/#8811
