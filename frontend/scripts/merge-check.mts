// 运行时验证：三方合并、差异挂起/选定、成果失效与重算
import 'fake-indexeddb/auto';
import { db } from '../src/utils/db.ts';
import { mergePut, rememberBases, getBase, forgetBase } from '../src/utils/merge.ts';
import { invalidateMissionAssets, recomputeMissionAssets } from '../src/utils/assetSync.ts';
import { computeLineDerived } from '../src/utils/lineMetrics.ts';
import type { Waypoint } from '../src/types/waypoint.ts';
import type { ImageAsset } from '../src/types/imageasset.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL ${name} ${extra}`);
  }
}

// 构造一条任务 + 航点 + 成果（绕过 seed）
const missionId = 'mission_test';
await db.missions.put({
  id: missionId,
  missionNo: 'T-1',
  name: 't',
  areaName: '测区',
  areaPolygon: [
    [100, 30],
    [100.01, 30],
    [100.01, 30.01],
  ],
  purpose: '正射',
  droneModel: 'x',
  cameraModel: 'c',
  sensorWidth: 13.2,
  sensorHeight: 8.8,
  focalLength: 8.8,
  pixelSize: 2.4,
  flightDate: '2026-09-30',
  pilot: 'p',
  status: '规划中',
  createdAt: 1,
});

const wp: Waypoint = {
  id: 'wp1',
  missionId,
  seq: 1,
  lng: 116.39,
  lat: 39.9,
  altitude: 120,
  speed: 8,
  heading: 90,
  gimbalPitch: -90,
  action: '拍照',
  hoverSec: 0,
  rev: 1,
};
await db.waypoints.put(wp);
rememberBases('waypoint', [wp]);

const asset: ImageAsset = {
  id: 'a1',
  missionId,
  imageNo: 'IMG_1',
  lng: 116.39,
  lat: 39.9,
  altitude: 120,
  gsd: 3.27,
  overlap: 75,
  tiltAngle: 0,
  shotAt: 1,
  quality: '合格',
  folder: '/f',
  rev: 1,
  stale: false,
  lineRev: 1,
};
await db.assets.put(asset);
rememberBases('asset', [asset]);

// 场景 1：标签页 A 改航高为 150（基于 rev=1）
const a = await mergePut('waypoint', { ...wp, altitude: 150 }, '标签页#1');
check('A 直接写回，无冲突', a.conflictFields.length === 0 && a.appliedLocal, JSON.stringify(a.conflictFields));

// 标签页 B 是另一个标签页：它的底本仍是 rev=1（删掉 A 写入后同步到本测试上下文的底本缓存来模拟）
forgetBase('waypoint', 'wp1');
rememberBases('waypoint', [{ ...wp }]);
// 场景 2：B 以 rev=1 为底，把航高改成 180（与 A 冲突），同时把航速改成 10（独立字段）
const b = await mergePut(
  'waypoint',
  { ...wp, altitude: 180, speed: 10 },
  '标签页#2',
);
check('B 仅 altitude 冲突', b.conflictFields.length === 1 && b.conflictFields[0] === 'altitude', JSON.stringify(b.conflictFields));
const afterB = await db.waypoints.get('wp1');
check('冲突字段保留 A 的 150（选定前不写回 B 的 180）', afterB.altitude === 150, `got ${afterB.altitude}`);
check('非冲突改动 speed=10 照常合入', afterB.speed === 10, `got ${afterB.speed}`);
check('rev 前进到 3', afterB.rev === 3, `got rev ${afterB.rev}`);
const conflicts = await db.conflicts.where('objectId').equals('wp1').toArray();
check('差异台账登记 1 条', conflicts.length === 1, `got ${conflicts.length}`);
check('台账并排双方值 180 / 150', conflicts[0].localValue === '180' && conflicts[0].remoteValue === '150');
check('台账记录共同底本 120', conflicts[0].baseValue === '120');

// 场景 3：B 再次保存（rev 仍停留在自己底本），altitude 仍是 180 -> 继续挂起不写回
const b2 = await mergePut('waypoint', { ...(getBase('waypoint', 'wp1') as Waypoint), altitude: 180, speed: 10 }, '标签页#2');
check('未选定前重复保存仍不写回', b2.conflictFields.length === 1, JSON.stringify(b2.conflictFields));

// 场景 4：双方收敛为同一值 -> 自动消解
const c = await mergePut('waypoint', { ...(getBase('waypoint', 'wp1') as Waypoint), altitude: 150, speed: 10 }, '标签页#2');
const conflictsAfterAgree = await db.conflicts.where('objectId').equals('wp1').toArray();
check('同值自动消解差异', c.conflictFields.length === 0 && conflictsAfterAgree.length === 0);

// 场景 5：成果失效 + 重算
const inv = await invalidateMissionAssets(missionId);
check('失效标记数量 1', inv === 1, `got ${inv}`);
let stale = await db.assets.where('missionId').equals(missionId).filter((x) => x.stale).toArray();
check('成果被标记 stale', stale.length === 1);
// 改航点航高到 200 后再重算
await db.waypoints.put({ ...(await db.waypoints.get('wp1')), altitude: 200, rev: 99 });
const r = await recomputeMissionAssets(missionId);
const after = await db.assets.get('a1');
// GSD = 2.4*200/(8.8*10) = 5.45
check('重算后清除 stale', r.recomputed === 1 && after.stale === false);
check('重算 GSD 跟随航点航高 200 -> 5.45', Math.abs(after.gsd - 5.45) < 1e-9, `got ${after.gsd}`);
check('人工编目质量保留', after.quality === '合格' && after.folder === '/f');

// 场景 6：航线参数三方合并 + 选定后成果按所选参数重算
const lineStoreMod = await import('../src/stores/lineStore.ts');
const lineConflictMod = await import('../src/stores/conflictStore.ts');
const { useLineStore } = lineStoreMod;
const { useConflictStore } = lineConflictMod;

const m2 = 'mission_line';
await db.missions.put({
  id: m2,
  missionNo: 'T-2',
  name: 't2',
  areaName: '测区2',
  areaPolygon: [
    [120, 31],
    [120.01, 31],
    [120.01, 31.01],
  ],
  purpose: '正射',
  droneModel: 'x',
  cameraModel: 'c',
  sensorWidth: 17.3,
  sensorHeight: 13,
  focalLength: 12.29,
  pixelSize: 3.3,
  flightDate: '2026-09-30',
  pilot: 'p',
  status: '规划中',
  createdAt: 2,
});
await db.waypoints.bulkPut([
  { id: 'w1', missionId: m2, seq: 1, lng: 120, lat: 31, altitude: 120, speed: 8, heading: 90, gimbalPitch: -90, action: '拍照', hoverSec: 0, rev: 1 },
  { id: 'w2', missionId: m2, seq: 2, lng: 120.01, lat: 31, altitude: 120, speed: 8, heading: 90, gimbalPitch: -90, action: '悬停', hoverSec: 4, rev: 1 },
]);
rememberBases('waypoint', await db.waypoints.where('missionId').equals(m2).toArray());
const a2: ImageAsset = {
  id: 'a2',
  missionId: m2,
  imageNo: 'IMG_9',
  lng: 120,
  lat: 31,
  altitude: 120,
  gsd: 3.22,
  overlap: 75,
  tiltAngle: 0,
  shotAt: 1,
  quality: '合格',
  folder: '/f2',
  rev: 1,
  stale: false,
  lineRev: 0,
};
await db.assets.put(a2);
rememberBases('asset', [a2]);

const baseInput = { altitude: 120, speed: 8, overlapForward: 75, overlapSide: 70, heading: 90 };
const missionRow2 = await db.missions.get(m2);
const wpRows = (await db.waypoints.where('missionId').equals(m2).toArray()).sort((a, b) => a.seq - b.seq);
// 预置 rev=1 的既有航线（与示范数据一致：打开多标签页时航线已存在）
const d0 = computeLineDerived(missionRow2, wpRows, baseInput);
await db.lines.put({ id: 'line2', missionId: m2, lineNo: 1, ...d0, ...baseInput, updatedAt: 100, rev: 1 });
rememberBases('line', await db.lines.where('missionId').equals(m2).toArray());
// 标签页#1 保存：旁向 60 -> rev 2
await useLineStore.getState().saveLine(m2, { ...baseInput, overlapSide: 60 });
const savedLine = (await db.lines.where('missionId').equals(m2).toArray())[0];
check('标签页#1 保存后航线 rev=2', savedLine.rev === 2, `got rev ${savedLine.rev}`);

// 模拟标签页#2：它的底本停留在 rev=1（初始参数），用合并引擎直接提交
// 航向 80（不同字段，自动合入），旁向 65（与已落库的 60 冲突）
const tab2Input = { ...baseInput, overlapForward: 80, overlapSide: 65 };
const d2 = computeLineDerived(missionRow2, wpRows, tab2Input);
const tab2Proposed = { ...savedLine, ...d2, overlapForward: 80, overlapSide: 65 };
forgetBase('line', 'line2');
rememberBases('line', [
  {
    id: 'line2',
    missionId: m2,
    lineNo: 1,
    ...d0,
    ...baseInput,
    spacing: d0.spacing,
    updatedAt: 100,
    rev: 1,
  },
]);
const second = await mergePut('line', tab2Proposed, '标签页#2');
const lineConflicts = await db.conflicts.where('missionId').equals(m2).toArray();
check('航线保存：旁向重叠率 + 派生量登记差异', second.conflictFields.includes('overlapSide') && lineConflicts.some((c) => c.field === 'overlapSide'), JSON.stringify(lineConflicts.map((c) => c.field)));
const lineNow = (await db.lines.where('missionId').equals(m2).toArray())[0];
check('冲突字段保留先写入的 60，选定前不写 65', lineNow.overlapSide === 60, `got ${lineNow.overlapSide}`);
check('非冲突的航向 80 照常合入', lineNow.overlapForward === 80, `got ${lineNow.overlapForward}`);

// 标签页#2 选定自己的 65 -> resolve('local')；应立刻让成果失效并重算 overlap=65
await useConflictStore.getState().resync();
await useConflictStore.getState().resolve(lineConflicts[0].id, 'local');
const assetNow = await db.assets.get('a2');
check('选定后成果 stale 已被重算清除', assetNow.stale === false, JSON.stringify({ stale: assetNow.stale }));
check('重算重叠度采用航向重叠率 80（资产重叠跟随航向）', assetNow.overlap === 80, `got ${assetNow.overlap}`);
check('选定后派生量差异自动作废', (await db.conflicts.where('missionId').equals(m2).filter((c) => ['spacing', 'photoInterval', 'gsd', 'estPhotos', 'estDuration', 'batteryCount'].includes(c.field)).count()) === 0);

// 归档闸口：有失效成果或未清差异时拒绝
await invalidateMissionAssets(m2);
const blockers = await useConflictStore.getState().archiveBlockers(m2);
check('归档闸口识别失效成果', blockers.staleAssets === 1, JSON.stringify(blockers));

// 场景 7：同一对象连续快速编辑串行化，不互相覆盖
const wpQ = 'wp_rapid';
await db.waypoints.put({
  id: wpQ,
  missionId: 'mission_test',
  seq: 9,
  lng: 116,
  lat: 39,
  altitude: 100,
  speed: 8,
  heading: 90,
  gimbalPitch: -90,
  action: '拍照',
  hoverSec: 0,
  rev: 1,
});
rememberBases('waypoint', await db.waypoints.where('id').equals(wpQ).toArray());
const rapidBase = await db.waypoints.get(wpQ);
const results = await Promise.all(
  [101, 102, 103, 104, 105].map((alt) => mergePut('waypoint', { ...rapidBase, altitude: alt }, '标签页#1')),
);
const finalWp = await db.waypoints.get(wpQ);
check('连续 5 次航高编辑全部完成', results.every((r) => r.conflictFields.length === 0), JSON.stringify(results.map((r) => r.conflictFields)));
check('连续编辑最终值为最后一次 105，无丢失', finalWp.altitude === 105, `got ${finalWp.altitude}`);
check('连续 5 次编辑 rev=6', finalWp.rev === 6, `got rev ${finalWp.rev}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
