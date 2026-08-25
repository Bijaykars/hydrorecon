# Nepal environmental-flow policy-floor screen

HydroRecon prevents a Nepal study from using less than 10% of the lowest monthly average discharge as
its desktop environmental release. This is a legal-policy floor for screening, not an ecological
flow assessment and not approval to construct or operate a diversion.

The Government of Nepal's [Hydropower Development Policy 2058 (2001), section
6.1.1](https://doed.gov.np/storage/listies/January2020/hydropower-development-policy-2058-2001.pdf)
requires the release to be the higher of:

- at least 10% of the minimum monthly average river discharge; or
- the minimum discharge required by the project's approved environmental impact assessment.

The [Nepal Law Commission's prevailing-law copy](https://repository.lawcommission.gov.np/np/documents/prevailing-law/%E0%A4%A8%E0%A5%80%E0%A4%A4%E0%A4%BF/%E0%A4%9C%E0%A4%B2%E0%A4%B5%E0%A4%BF%E0%A4%A6%E0%A5%8D%E0%A4%AF%E0%A5%81%E0%A4%A4-%E0%A4%B5%E0%A4%BF%E0%A4%95%E0%A4%BE%E0%A4%B8-%E0%A4%A8%E0%A5%80%E0%A4%A4%E0%A4%BF-%E0%A5%A8%E0%A5%A6%E0%A5%AB/%E0%A5%AC-%E0%A4%95%E0%A4%BE%E0%A4%B0%E0%A5%8D%E0%A4%AF%E0%A4%A8%E0%A5%80%E0%A4%A4%E0%A4%BF%C3%B7%E0%A4%9C%E0%A4%B2%E0%A4%B5%E0%A4%BF/)
is retained as a second official source. Both were reviewed on 13 August 2026.

## Calculation

For the active measured or modelled discharge record, HydroRecon first calculates a mean for every
represented calendar month and takes the lowest monthly mean. The screening release is:

```text
policy-floor release = lowest monthly mean discharge × selected fraction
selected fraction in Nepal = max(user scenario, 0.10)
```

The release is subtracted from river flow before turbine capacity and part-load efficiency are
applied. Consequently a higher release can only reduce design discharge and energy; it cannot be
silently added after the energy calculation. When the user moves from global mode into Nepal, an
existing value below 10% is clamped before calculation or export.

The Nepal interface exposes 10–50% scenarios. Ten percent is the lowest legal-policy screen, not a
recommended ecological-flow target. The engineer can raise the value to test a known EIA minimum
or a more conservative scenario.

## Evidence still required

An approved release regime needs project evidence that this desktop model does not contain:

- seasonal habitat and aquatic-ecology requirements;
- drinking, irrigation, mill, cultural and other downstream water uses;
- drought, ramping, peaking and cascade-operation rules;
- fish passage and sediment/connectivity effects;
- intake, gate or bypass works capable of releasing the required flow under all operating states;
- measurement location, accuracy, telemetry, reporting and compliance arrangements; and
- the current approved EIA and licence/PPA conditions.

HydroRecon therefore leaves the legal/environmental gate open and writes these requirements into the
field investigation plan. CSV provenance records the selected fraction, source and non-claim.
GeoJSON additionally records the selected scheme's release in cubic metres per second. Global mode
exports no Nepal policy object and leaves its residual-flow minimum at zero so the host-country rule
can be supplied without importing Nepal law.

## Reproducibility guardrails

`NEPAL_EFLOW_POLICY` is the single runtime policy constant used by the default, Nepal clamp,
readiness evidence and exports. Automated tests lock the 10% boundary, accept higher engineer-set
scenarios, reject non-finite values to the safe floor, preserve the higher-EIA rule, and verify that
the Nepal policy never leaks into global mode.
