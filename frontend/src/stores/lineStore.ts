import { create } from 'zustand';
import { db, loadFlightLine } from '../utils/db';
import { mergePut, rememberBases } from '../utils/merge';
import { computeLineDerived, type LineParamsInput } from '../utils/lineMetrics';
import { scheduleAssetRecompute } from '../utils/assetSync';
import { emitSync } from '../utils/syncBus';
import { DERIVED_LINE_FIELDS } from '../types/merge';
import { TAB_ID } from '../utils/tabId';
import { newId } from '../utils/id';
import type { FlightLine, FlightLineDraft } from '../types/flightline';

interface LineState {
  items: FlightLine[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 从库中全量重拉（跨标签页变更后调用） */
  resync: () => Promise<void>;
  byMission: (missionId: string) => FlightLine | undefined;
  /**
   * 保存航线参数：按对象三方合并。
   * 本页值真正落库后，立刻让该任务成果失效并按新参数重算。
   * 返回仍待选定的字段（非空时 UI 提示「选定前未写回」）。
   */
  saveLine: (missionId: string, input: LineParamsInput) => Promise<{ line: FlightLine; conflictFields: string[] }>;
}

/** 依据最新任务 / 航点，把输入参数回算成完整航线对象（不含 id / 时间戳 / rev） */
async function buildDraft(missionId: string, input: LineParamsInput): Promise<FlightLineDraft> {
  const [mission, waypoints] = await Promise.all([
    db.missions.get(missionId),
    db.waypoints.where('missionId').equals(missionId).toArray(),
  ]);
  const points = waypoints.sort((a, b) => a.seq - b.seq);
  const derived = computeLineDerived(mission, points, input);
  return {
    missionId,
    lineNo: 1,
    ...derived,
    overlapForward: input.overlapForward,
    overlapSide: input.overlapSide,
    heading: input.heading,
  };
}

export const useLineStore = create<LineState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    await get().resync();
    set({ loaded: true });
  },
  async resync() {
    const rows = await db.lines.toArray();
    rememberBases('line', rows);
    set({ items: rows });
  },
  byMission(missionId) {
    return get()
      .items.filter((l) => l.missionId === missionId)
      .sort((a, b) => a.lineNo - b.lineNo)[0];
  },
  async saveLine(missionId, input) {
    const existing = await loadFlightLine(missionId);
    const draft = await buildDraft(missionId, input);
    const prevRev = existing?.rev ?? 0;

    let line: FlightLine;
    let conflictFields: string[];
    let appliedLocal = false;

    if (existing) {
      const proposed: FlightLine = { ...existing, ...draft, id: existing.id };
      const result = await mergePut('line', proposed, TAB_ID);
      line = result.committed ?? existing;
      conflictFields = result.conflictFields;
      appliedLocal = result.appliedLocal;
    } else {
      line = { id: newId('line'), ...draft, updatedAt: Date.now(), rev: 1 };
      await db.lines.put(line);
      rememberBases('line', [line]);
      conflictFields = [];
      appliedLocal = true;
    }

    await get().resync();
    if (appliedLocal && line.rev > prevRev) {
      // 航线参数改动落库：相关成果立刻失效并重算（广播由 assetSync 统一发出）
      scheduleAssetRecompute(missionId);
    }
    emitSync(['lines', 'conflicts'], [missionId]);
    return { line, conflictFields };
  },
}));

/**
 * 差异选定后按库内最新输入参数回算整条航线的派生指标
 *（GSD、间距、张数、耗时、电池组），返回更新后的航线。
 */
export async function refinalizeLine(missionId: string): Promise<FlightLine | undefined> {
  const line = await loadFlightLine(missionId);
  if (!line) return undefined;
  const [mission, waypoints] = await Promise.all([
    db.missions.get(missionId),
    db.waypoints.where('missionId').equals(missionId).toArray(),
  ]);
  const points = waypoints.sort((a, b) => a.seq - b.seq);
  const input: LineParamsInput = {
    altitude: points[0]?.altitude ?? 120,
    speed: points[0]?.speed ?? 8,
    overlapForward: line.overlapForward,
    overlapSide: line.overlapSide,
    heading: line.heading,
  };
  const derived = computeLineDerived(mission, points, input);
  const next: FlightLine = {
    ...line,
    ...derived,
    overlapForward: line.overlapForward,
    overlapSide: line.overlapSide,
    heading: line.heading,
    updatedAt: Date.now(),
    rev: line.rev + 1,
  };
  await db.transaction('rw', [db.lines, db.conflicts], async () => {
    await db.lines.put(next);
    // 派生量已按选定后的输入统一重算：清掉这些字段上残留的待决差异
    const stale = (await db.conflicts.where('objectId').equals(line.id).toArray()).filter((c) =>
      (DERIVED_LINE_FIELDS as readonly string[]).includes(c.field),
    );
    if (stale.length > 0) await db.conflicts.bulkDelete(stale.map((c) => c.id));
  });
  rememberBases('line', [next]);
  return next;
}
