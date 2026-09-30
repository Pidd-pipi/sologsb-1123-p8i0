import {
  calcGsd,
  estimateBatteries,
  estimateDuration,
  estimatePhotos,
  lineSpacing,
  pathLengthMeters,
  photoInterval,
  polygonAreaM2,
} from './geoCalc';
import type { Mission } from '../types/mission';
import type { Waypoint } from '../types/waypoint';

export interface LineParamsInput {
  altitude: number;
  speed: number;
  overlapForward: number;
  overlapSide: number;
  heading: number;
}

export interface LineDerived {
  spacing: number;
  photoInterval: number;
  gsd: number;
  estPhotos: number;
  estDuration: number;
  batteryCount: number;
}

/**
 * 由任务传感器、航点与当前航线输入参数，回算航线的派生指标。
 * 保存航线参数与重算失效成果共用这一份口径。
 */
export function computeLineDerived(mission: Mission | undefined, points: Waypoint[], input: LineParamsInput): LineDerived {
  const sensorWidth = mission?.sensorWidth ?? 13.2;
  const sensorHeight = mission?.sensorHeight ?? 8.8;
  const focalLength = mission?.focalLength ?? 8.8;
  const pixelSize = mission?.pixelSize ?? 2.4;

  const gsd = calcGsd(pixelSize, input.altitude, focalLength);
  const spacing = lineSpacing(sensorWidth, input.altitude, focalLength, input.overlapSide);
  const interval = photoInterval(sensorHeight, input.altitude, focalLength, input.overlapForward);
  const area = mission ? polygonAreaM2(mission.areaPolygon) : 0;
  const path = pathLengthMeters(points.map((w) => [w.lng, w.lat]));
  const side = area > 0 ? Math.sqrt(area) : 0;
  const lineCount = spacing > 0 && side > 0 ? Math.max(1, Math.ceil(side / spacing)) : 0;
  const effLineLength = lineCount > 0 ? (area > 0 ? (area / (lineCount * Math.max(spacing, 1))) * spacing : 0) : 0;
  const estPhotos = estimatePhotos(effLineLength || side, interval, lineCount);
  const hoverSecTotal = points.reduce((s, w) => s + (w.action === '悬停' ? w.hoverSec : 0), 0);
  const estDuration = estimateDuration(path, input.speed, points.length, hoverSecTotal);
  const batteryCount = estimateBatteries(estDuration);

  return { spacing, photoInterval: interval, gsd, estPhotos, estDuration, batteryCount };
}
