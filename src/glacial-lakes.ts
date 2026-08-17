/** Open Sentinel-2 glacial-lake evidence for Nepal's transboundary basins. */
import raw from './data/nepal-glacial-lakes.json' with { type: 'json' };

type RawLake = [
  id: string,
  country: string,
  basin: string,
  connectivity: string,
  elevationM: number,
  expansionRateKm2Yr: number | null,
  expansionUncertaintyKm2Yr: number | null,
  expansionSignificant: boolean | null,
  timeSeriesOutlier: boolean | null,
  lat: number,
  lon: number,
];

type RawBundle = {
  _source: string;
  _record: string;
  _file: string;
  _checksum: string;
  _published: string;
  _retrieved: string;
  _observations: { from: number; to: number; sensor: string };
  _crs: string;
  _license: string;
  _licenseUrl: string;
  _citation: string;
  _quality: string;
  _note: string;
  _counts: {
    total: number;
    countries: Record<string, number>;
    basins: Record<string, number>;
  };
  lakes: RawLake[];
};

const BUNDLE = raw as unknown as RawBundle;

export type GlacialLake = {
  id: string;
  country: 'Nepal' | 'China' | 'India';
  basin: 'Koshi' | 'Gandaki' | 'Karnali';
  connectivity: 'Glacier-fed' | 'Non Glacier-fed';
  elevationM: number;
  /** Published 2017-2024 lake-area trend, km2/year. Null means unavailable. */
  expansionRateKm2Yr: number | null;
  expansionUncertaintyKm2Yr: number | null;
  expansionSignificant: boolean | null;
  timeSeriesOutlier: boolean | null;
  lat: number;
  lon: number;
};

export type GlacialLakeInventory = {
  lakes: readonly GlacialLake[];
  source: string;
  record: string;
  file: string;
  checksum: string;
  published: string;
  retrieved: string;
  observations: { from: number; to: number; sensor: string };
  crs: string;
  license: string;
  licenseUrl: string;
  citation: string;
  quality: string;
  limitation: string;
  counts: RawBundle['_counts'];
};

const LAKES: readonly GlacialLake[] = BUNDLE.lakes.map((lake) => ({
  id: lake[0],
  country: lake[1] as GlacialLake['country'],
  basin: lake[2] as GlacialLake['basin'],
  connectivity: lake[3] as GlacialLake['connectivity'],
  elevationM: lake[4],
  expansionRateKm2Yr: lake[5],
  expansionUncertaintyKm2Yr: lake[6],
  expansionSignificant: lake[7],
  timeSeriesOutlier: lake[8],
  lat: lake[9],
  lon: lake[10],
}));

export const GLACIAL_LAKE_COUNT = BUNDLE._counts.total;
export const GLACIAL_LAKE_RETRIEVED = BUNDLE._retrieved;

export function glacialLakeInventory(): GlacialLakeInventory {
  return {
    lakes: LAKES,
    source: BUNDLE._source,
    record: BUNDLE._record,
    file: BUNDLE._file,
    checksum: BUNDLE._checksum,
    published: BUNDLE._published,
    retrieved: BUNDLE._retrieved,
    observations: BUNDLE._observations,
    crs: BUNDLE._crs,
    license: BUNDLE._license,
    licenseUrl: BUNDLE._licenseUrl,
    citation: BUNDLE._citation,
    quality: BUNDLE._quality,
    limitation: BUNDLE._note,
    counts: BUNDLE._counts,
  };
}
