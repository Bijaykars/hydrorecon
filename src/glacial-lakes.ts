/** Open Sentinel-2 glacial-lake evidence for Nepal's transboundary basins. */
import raw from './data/nepal-glacial-lakes.json' with { type: 'json' };
import pdglRaw from './data/nepal-pdgl.json' with { type: 'json' };

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
  /**
   * ICIMOD's 2020 danger assessment, where this lake is one of the 47
   * potentially dangerous glacial lakes. Rank I is the highest hazard level.
   */
  pdgl: { rank: 1 | 2 | 3; name: string | null } | null;
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

/**
 * ICIMOD's 47 potentially dangerous lakes, joined by position.
 *
 * The PDGL id encodes its own coordinates — GL087945E27781N is 87.945E
 * 27.781N — and the Sentinel-2 inventory uses a different id scheme, so the
 * join is by distance. 2 km of slack covers the epoch difference between the
 * two surveys (large lakes grow, and their centroids move) while staying well
 * under the spacing between neighbouring lakes on the same rank list.
 */
const PDGL = (pdglRaw as unknown as {
  lakes: [string, number, string, string, string | null][];
}).lakes.map(([id, rank, , , name]) => ({
  rank: rank as 1 | 2 | 3,
  name,
  lon: Number(id.slice(2, 8)) / 1000,
  lat: Number(id.slice(9, 14)) / 1000,
}));

const PDGL_JOIN_KM = 2;

/**
 * One flag per PDGL, on its nearest inventory lake only. The naive direction
 * — flag every inventory lake within range — marked 146 lakes for 47 entries,
 * because a big lake like Tsho Rolpa is ringed by satellite ponds that are NOT
 * on ICIMOD's list.
 */
const kmBetween = (aLat: number, aLon: number, bLat: number, bLon: number) =>
  Math.hypot((aLat - bLat) * 111.32, (aLon - bLon) * 111.32 * Math.cos((aLat * Math.PI) / 180));

const PDGL_BY_LAKE = new Map<number, GlacialLake['pdgl']>();
for (const p of PDGL) {
  let bestI = -1;
  let bestKm = PDGL_JOIN_KM;
  for (let i = 0; i < BUNDLE.lakes.length; i++) {
    const km = kmBetween(p.lat, p.lon, BUNDLE.lakes[i][9], BUNDLE.lakes[i][10]);
    if (km < bestKm) {
      bestKm = km;
      bestI = i;
    }
  }
  // A PDGL with no inventory lake in range stays unflagged rather than
  // grabbing a neighbour; two PDGLs never share one lake — closer wins.
  if (bestI >= 0 && !PDGL_BY_LAKE.has(bestI)) PDGL_BY_LAKE.set(bestI, { rank: p.rank, name: p.name });
}

const LAKES: readonly GlacialLake[] = BUNDLE.lakes.map((lake, index) => ({
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
  pdgl: PDGL_BY_LAKE.get(index) ?? null,
}));

export const PDGL_COUNT = PDGL.length;
export const PDGL_MATCHED = LAKES.filter((l) => l.pdgl).length;

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
