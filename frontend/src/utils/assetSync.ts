/**
 * 成果影像失效与重算。
 *
 * 航线参数（含相机传感器）改动后，任务相关成果立刻标记 stale=true（保留原条目供台账计数），
 * 随后按最新航点位置与航线参数重算 GSD / 重叠度 / 航高 / 倾角并清除失效标记。
 * 重算只刷新派生量，片号、坐标、质量、归档目录等人工编目内容原样保留。
 *
 * 直接读写 db，避免与各 zustand store 形成循环依赖；每次落库后刷新 store 并广播，
 * 保证本页与其他标签页（BroadcastChannel 不回送发送方）都能立刻读到同一版本。
 */
import { db, loadFlightLine } from './db';
import { calcGsd } from './geoCalc';
import { rememberBases } from './merge';
import { emitSync } from './syncBus';
import { useAssetStore } from '../stores/assetStore';
import type { ImageAsset } from '../types/imageasset';
import type { Waypoint } from '../types/waypoint';

export interface RecomputeResult {
  invalidated: number;
  recomputed: number;
}

const scheduled = new Map<string, ReturnType<typeof setTimeout>>();

function publishAssets(missionId: string): void {
  // 本页 zustand 立刻重拉，再广播给其他标签页
  void useAssetStore.getState().resync();
  emitSync(['assets', 'conflicts'], [missionId]);
}

/** 立刻把任务下所有成果标为失效；lineRev=0 表示「等待按新航线重算」 */
export async function invalidateMissionAssets(missionId: string): Promise<number> {
  const rows = await db.assets.where('missionId').equals(missionId).toArray();
  const due = rows.filter((a) => !a.stale);
  if (due.length === 0) return 0;
  const next: ImageAsset[] = due.map((a) => ({ ...a, stale: true, lineRev: 0, rev: a.rev + 1 }));
  await db.assets.bulkPut(next);
  rememberBases('asset', next);
  publishAssets(missionId);
  return next.length;
}

/** 按最新航点 + 航线参数 + 任务传感器重算失效成果 */
export async function recomputeMissionAssets(missionId: string): Promise<RecomputeResult> {
  const [mission, line, staleRows] = await Promise.all([
    db.missions.get(missionId),
    loadFlightLine(missionId),
    db.assets.where('missionId').equals(missionId).filter((a) => a.stale).toArray(),
  ]);
  if (!mission || staleRows.length === 0) return { invalidated: 0, recomputed: 0 };

  const waypoints = (await db.waypoints.where('missionId').equals(missionId).toArray()).sort((a, b) => a.seq - b.seq);
  const overlapForward = line?.overlapForward ?? 75;
  const lineRev = line?.rev ?? 0;

  const recomputeOne = (asset: ImageAsset): ImageAsset => {
    // 定位到最近航点：位置不变，但航高 / 倾角随航点与当前云台更新
    let nearest: Waypoint | undefined;
    let best = Number.POSITIVE_INFINITY;
    waypoints.forEach((w) => {
      const d = (asset.lng - w.lng) ** 2 + (asset.lat - w.lat) ** 2;
      if (d < best) {
        best = d;
        nearest = w;
      }
    });
    const altitude = nearest?.altitude ?? asset.altitude;
    const gsd = calcGsd(mission.pixelSize, altitude, mission.focalLength);
    return {
      ...asset,
      altitude,
      gsd: gsd || asset.gsd,
      overlap: overlapForward,
      tiltAngle: nearest ? Math.abs(nearest.gimbalPitch + 90) : asset.tiltAngle,
      stale: false,
      lineRev,
      rev: asset.rev + 1,
    };
  };

  const next = staleRows.map(recomputeOne);
  await db.assets.bulkPut(next);
  rememberBases('asset', next);
  publishAssets(missionId);
  return { invalidated: staleRows.length, recomputed: next.length };
}

/**
 * 失效 + 延迟重算的组合入口：先立刻失效（页面上马上看到「失效待重算」），
 * 短延时后执行重算，期间新的改动会替换旧的延时任务。
 */
export function scheduleAssetRecompute(missionId: string, _reasonRev = 0, delayMs = 900): void {
  const old = scheduled.get(missionId);
  if (old) clearTimeout(old);
  void invalidateMissionAssets(missionId);
  const timer = setTimeout(() => {
    scheduled.delete(missionId);
    void recomputeMissionAssets(missionId);
  }, delayMs);
  scheduled.set(missionId, timer);
}

/** 取消尚未执行的重算任务（差异选定需要立即重算时先调用，避免旧任务再写一遍） */
export function cancelScheduledRecompute(missionId: string): void {
  const old = scheduled.get(missionId);
  if (old) {
    clearTimeout(old);
    scheduled.delete(missionId);
  }
}

/** 立即失效并重算（差异选定等需要立刻拿到结果的场景） */
export async function invalidateAndRecompute(missionId: string): Promise<RecomputeResult> {
  cancelScheduledRecompute(missionId);
  const invalidated = await invalidateMissionAssets(missionId);
  const result = await recomputeMissionAssets(missionId);
  return { invalidated, recomputed: result.recomputed };
}
