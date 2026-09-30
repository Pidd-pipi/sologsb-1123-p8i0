import { useMemo } from 'react';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { groundCoverage, pathLengthMeters, polygonAreaM2 } from '../utils/geoCalc';
import { computeLineDerived } from '../utils/lineMetrics';
import type { LngLat } from '../types/mission';

export interface RouteParams {
  /** 相对航高 m */
  altitude: number;
  /** 航速 m/s */
  speed: number;
  /** 航向重叠率 % */
  overlapForward: number;
  /** 旁向重叠率 % */
  overlapSide: number;
  /** 航带方向 ° */
  heading: number;
}

export const DEFAULT_ROUTE_PARAMS: RouteParams = {
  altitude: 120,
  speed: 8,
  overlapForward: 75,
  overlapSide: 70,
  heading: 90,
};

export interface RouteMetrics {
  gsd: number;
  spacing: number;
  photoInterval: number;
  estPhotos: number;
  estDuration: number;
  batteryCount: number;
  /** 测区面积 m² */
  area: number;
  /** 航带路径长度 m */
  pathLength: number;
  /** 航点数量 */
  waypointCount: number;
  /** 预计航带数 */
  lineCount: number;
  coverageForward: number;
  coverageSide: number;
  sorties: { sortie: number; photos: number; durationMin: number }[];
}

/**
 * 由航高、焦距、像元尺寸算 GSD、航线间距、预计张数与耗时。
 * 被航线规划页（/missions/:id/route）与航点明细页（/missions/:id/waypoints）消费。
 */
export function useRouteMetrics(missionId: string | undefined, params: RouteParams = DEFAULT_ROUTE_PARAMS): RouteMetrics {
  const missions = useMissionStore((s) => s.items);
  const allWaypoints = useWaypointStore((s) => s.items);

  return useMemo<RouteMetrics>(() => {
    const mission = missions.find((m) => m.id === missionId);
    const points = allWaypoints
      .filter((w) => w.missionId === missionId)
      .sort((a, b) => a.seq - b.seq);
    const lngLats: LngLat[] = points.map((w) => [w.lng, w.lat] as LngLat);

    const focalLength = mission?.focalLength ?? 8.8;
    const sensorWidth = mission?.sensorWidth ?? 13.2;
    const sensorHeight = mission?.sensorHeight ?? 8.8;

    const derived = computeLineDerived(mission, points, params);
    const area = mission ? polygonAreaM2(mission.areaPolygon) : 0;
    const pathLength = pathLengthMeters(lngLats);
    const side = area > 0 ? Math.sqrt(area) : 0;
    const lineCount = derived.spacing > 0 && side > 0 ? Math.max(1, Math.ceil(side / derived.spacing)) : 0;
    const sortieCount = Math.max(1, Math.ceil(derived.estDuration / 20));

    return {
      ...derived,
      area,
      pathLength,
      waypointCount: points.length,
      lineCount,
      coverageForward: Math.round(groundCoverage(sensorHeight, params.altitude, focalLength) * 100) / 100,
      coverageSide: Math.round(groundCoverage(sensorWidth, params.altitude, focalLength) * 100) / 100,
      sorties: Array.from({ length: sortieCount }, (_, i) => ({
        sortie: i + 1,
        photos: Math.ceil(derived.estPhotos / sortieCount),
        durationMin: Math.round((derived.estDuration / sortieCount) * 10) / 10,
      })),
    };
  }, [missions, allWaypoints, missionId, params]);
}
