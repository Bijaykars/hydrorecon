"""Real HydroGenerate vs the hand-written TypeScript port, on five built plants.

Emits JSON so a Node script can diff it against src/engine/turbine.ts.
"""
import json
import numpy as np
from HydroGenerate.turbine_calculation import (
    TurbineParameters,
    turbine_type_selector,
    FrancisTurbine,
    KaplanTurbine,
    PeltonTurbine,
    TurgoTurbine,
    CrossFlowTurbine,
    PropellerTurbine,
)

PLANTS = [
    ("Chilime",         337.46,  7.5),
    ("Upper Tamakoshi", 780.90, 66.0),
    ("Nyadi",           317.21, 11.02),
    ("Kabeli A",        111.15, 37.73),
    ("Rasuwagadhi",     159.51, 80.0),
]

CALC = {
    "Francis": FrancisTurbine,
    "Kaplan": KaplanTurbine,
    "Pelton": PeltonTurbine,
    "Turgo": TurgoTurbine,
    "Crossflow": CrossFlowTurbine,
    "Propeller": PropellerTurbine,
}

# Flows to sample the efficiency curve at, as a fraction of design.
FRACS = [0.3, 0.5, 0.7, 0.85, 1.0]

out = []
for name, head, q in PLANTS:
    rec = {"plant": name, "headM": head, "designFlowCms": q}
    t = TurbineParameters(
        turbine_type=None, flow=q, design_flow=q, flow_column=None, head=head,
        rated_power=None, system_efficiency=None, generator_efficiency=None,
        Rm=None, pctime_runfull=None, pelton_n_jets=None, hk_blade_diameter=None,
        hk_blade_heigth=None, hk_blade_type=None, hk_swept_area=None,
    )
    try:
        turbine_type_selector(t)
        rec["turbine"] = t.turbine_type
    except ValueError as e:
        rec["turbine"] = None
        rec["error"] = str(e)
        out.append(rec)
        continue

    # Evaluate the library's own curve at our sample flows.
    effs = {}
    for f in FRACS:
        t2 = TurbineParameters(
            turbine_type=t.turbine_type, flow=q * f, design_flow=q, flow_column=None,
            head=head, rated_power=None, system_efficiency=None,
            generator_efficiency=None, Rm=None, pctime_runfull=None,
            pelton_n_jets=None, hk_blade_diameter=None, hk_blade_heigth=None,
            hk_blade_type=None, hk_swept_area=None,
        )
        t2.turbine_flow = np.array([q * f])
        CALC[t.turbine_type]().turbine_calculator(t2)
        effs[str(f)] = float(np.atleast_1d(t2.turbine_efficiency)[0])
    rec["eff"] = effs
    out.append(rec)

print(json.dumps(out, indent=1))
