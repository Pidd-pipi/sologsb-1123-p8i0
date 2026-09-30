/**
 * 多标签页合并 / 失效重算的聚合查询与归档门禁。
 */
import { useWaypointStore } from '../stores/waypointStore';
import { useLineStore } from '../stores/lineStore';
import { useAssetStore } from '../stores/assetStore';
import type { FieldConflict } from './merge';

export interface CollabSummary {
  totalConflicts: number;
  totalStale: number;
  /** 存在未解决冲突的任务 id */
  conflictMissionIds: string[];
  /** 存在待重算成果的任务 id */
  staleMissionIds: string[];
}

/** 聚合三个 store 的冲突与失效成果数量（响应式） */
export function useCollabSummary(): CollabSummary {
  const wpConflicts = useWaypointStore((s) => s.conflicts);
  const lineConflicts = useLineStore((s) => s.conflicts);
  const assetConflicts = useAssetStore((s) => s.conflicts);
  const assets = useAssetStore((s) => s.items);

  const conflicts: FieldConflict[] = [...wpConflicts, ...lineConflicts, ...assetConflicts];
  const stale = assets.filter((a) => a.stale);
  const conflictMissionIds = Array.from(new Set(conflicts.map((c) => c.missionId)));
  const staleMissionIds = Array.from(new Set(stale.map((a) => a.missionId)));

  return {
    totalConflicts: conflicts.length,
    totalStale: stale.length,
    conflictMissionIds,
    staleMissionIds,
  };
}

/** 归档门禁：返回某任务尚未结清的差异（冲突 / 失效成果），为空才允许归档 */
export function getArchiveBlockers(missionId: string): string[] {
  const wp = useWaypointStore.getState().conflicts.filter((c) => c.missionId === missionId);
  const ln = useLineStore.getState().conflicts.filter((c) => c.missionId === missionId);
  const as = useAssetStore.getState().conflicts.filter((c) => c.missionId === missionId);
  const stale = useAssetStore.getState().items.filter((a) => a.missionId === missionId && a.stale);

  const blockers: string[] = [];
  if (wp.length > 0) blockers.push(`航点有 ${wp.length} 处冲突未解决`);
  if (ln.length > 0) blockers.push(`航线参数有 ${ln.length} 处冲突未解决`);
  if (as.length > 0) blockers.push(`成果影像有 ${as.length} 处冲突未解决`);
  if (stale.length > 0) blockers.push(`有 ${stale.length} 张成果影像待重算`);
  return blockers;
}

/** 某任务的冲突数与失效数（响应式，供页面横幅使用） */
export function useMissionCollab(missionId: string | undefined): { conflicts: FieldConflict[]; staleCount: number } {
  const wpConflicts = useWaypointStore((s) => s.conflicts);
  const lineConflicts = useLineStore((s) => s.conflicts);
  const assetConflicts = useAssetStore((s) => s.conflicts);
  const staleCount = useAssetStore((s) => s.items.filter((a) => a.missionId === missionId && a.stale).length);
  if (!missionId) return { conflicts: [], staleCount: 0 };
  const conflicts = [...wpConflicts, ...lineConflicts, ...assetConflicts].filter((c) => c.missionId === missionId);
  return { conflicts, staleCount };
}
