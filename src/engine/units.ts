import {
  HOURS_PER_YEAR,
  USGS_NO_DATA,
  netHead,
  netHeadAt,
  powerW,
  valueAtExceedance,
  type PlantParams,
} from './hydro.ts';
import { turbineCurve, type TurbineType } from './turbine.ts';

export const UNIT_SENSITIVITY_GUIDANCE = {
  unitCounts: [1, 2, 3, 4],
  method:
    'Equal-rated identical-unit sensitivity. For each day and installed-unit count, test every feasible number of running units and retain the highest instantaneous power.',
  technicalSource:
    'https://energypedia.info/images/c/ca/Part_1_guide_on_how_to_develop_a_small_hydropower_plant-_final1.pdf',
  technicalReference:
    'ESHA 2004 sections 3.6-3.7: turbine minimum technical flow, part-load efficiency, capacity and firm-energy screening',
  nepalOperatingCase:
    'https://www.hydropower.org/sediment-management-case-studies/nepal-jhimruk',
  reviewed: '2026-08-13',
  interpretation:
    'Sensitivity only—not a selected unit arrangement, supplier guarantee, cost optimum, firm-capacity result, outage model or transient study.',
} as const;

export type UnitCountScenario = {
  units: number;
  unitDesignFlowCms: number;
  turbine: TurbineType | null;
  capacityMW: number;
  energyGwh: number;
  plantFactor: number;
  dailyP90MW: number;
  dailyP95MW: number;
  zeroOutputFraction: number;
  days: number;
};

export type UnitSensitivityInput = {
  seriesCms: readonly number[];
  grossHeadM: number;
  headLossFrac: number;
  totalDesignFlowCms: number;
  residualFlowCms: number;
  generatorTransformerEfficiency: number;
  fallbackMinFlowFrac: number;
  unitCounts?: readonly number[];
};

/**
 * Dispatch equal-rated units and expose the unit-number sensitivity without
 * pretending that extra machines are free or already selected.
 */
export function unitCountSensitivity(input: UnitSensitivityInput): UnitCountScenario[] {
  const clean = input.seriesCms.filter(
    (value) => Number.isFinite(value) && value > USGS_NO_DATA + 1
  );
  if (
    clean.length === 0 ||
    !(input.grossHeadM > 0) ||
    !(input.totalDesignFlowCms > 0) ||
    !(input.generatorTransformerEfficiency > 0)
  ) {
    return [];
  }

  const headModel: PlantParams = {
    grossHeadM: input.grossHeadM,
    headLossFrac: Math.max(0, input.headLossFrac),
    efficiency: 1,
    designFlowCms: input.totalDesignFlowCms,
    residualFlowCms: Math.max(0, input.residualFlowCms),
    minFlowFrac: 0,
  };
  const counts = [...new Set(input.unitCounts ?? UNIT_SENSITIVITY_GUIDANCE.unitCounts)]
    .filter((count) => Number.isInteger(count) && count >= 1 && count <= 12)
    .sort((a, b) => a - b);

  return counts.map((units) => {
    const unitDesignFlowCms = input.totalDesignFlowCms / units;
    const curve = turbineCurve(unitDesignFlowCms, netHead(headModel));
    const minimumFraction = curve?.minFlowFrac ?? input.fallbackMinFlowFrac;
    const powers = clean.map((riverFlowCms) => {
      const available = Math.min(
        input.totalDesignFlowCms,
        Math.max(0, riverFlowCms - headModel.residualFlowCms)
      );
      let bestW = 0;
      for (let running = 1; running <= units; running++) {
        const totalTurbineFlow = Math.min(available, running * unitDesignFlowCms);
        const perUnitFlow = totalTurbineFlow / running;
        if (perUnitFlow < minimumFraction * unitDesignFlowCms) continue;
        const turbineEfficiency = curve ? curve.at(perUnitFlow) : 1;
        const watts = powerW(
          totalTurbineFlow,
          netHeadAt(headModel, totalTurbineFlow),
          turbineEfficiency * input.generatorTransformerEfficiency
        );
        if (watts > bestW) bestW = watts;
      }
      return bestW;
    });
    const meanW = powers.reduce((sum, watts) => sum + watts, 0) / powers.length;
    const capacityW = powerW(
      input.totalDesignFlowCms,
      netHead(headModel),
      (curve?.peak ?? 1) * input.generatorTransformerEfficiency
    );
    return {
      units,
      unitDesignFlowCms,
      turbine: curve?.type ?? null,
      capacityMW: capacityW / 1e6,
      energyGwh: (meanW * HOURS_PER_YEAR) / 1e9,
      plantFactor: capacityW > 0 ? meanW / capacityW : 0,
      dailyP90MW: valueAtExceedance(powers, 0.9) / 1e6,
      dailyP95MW: valueAtExceedance(powers, 0.95) / 1e6,
      zeroOutputFraction: powers.filter((watts) => watts <= 0).length / powers.length,
      days: powers.length,
    };
  });
}
