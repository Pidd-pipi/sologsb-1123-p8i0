import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Popconfirm, Row, Space, Table, Tag, Typography, message, type TableProps } from 'antd';
import { useMissionStore, ArchiveBlockedError } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useLineStore } from '../stores/lineStore';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS, type RouteParams } from '../hooks/useRouteMetrics';
import AmapRouteView from '../components/common/AmapRouteView';
import OverlapCalcPanel from '../components/common/OverlapCalcPanel';
import MergeConflictsCard from '../components/common/MergeConflictsCard';
import { splitSorties } from '../utils/db';
import type { FlightLine } from '../types/flightline';
import type { Waypoint } from '../types/waypoint';

type LineRow = { key: string; label: string; value: string };

const lineColumns: NonNullable<TableProps<LineRow>['columns']> = [
  { title: '项', dataIndex: 'label', width: 160 },
  { title: '值', dataIndex: 'value' },
];

/** /missions/:id/route 航线规划主视图：地图 + 参数面板实时回算，保存按对象三方合并 */
export default function RoutePlanner() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const addWaypoint = useWaypointStore((s) => s.add);
  const archiveMission = useMissionStore((s) => s.archive);
  const line = useLineStore((s) => s.items.find((l) => l.missionId === id));
  const saveLine = useLineStore((s) => s.saveLine);
  const allAssets = useAssetStore((s) => s.items);
  const staleAssets = useMemo(() => allAssets.filter((a) => a.missionId === id && a.stale), [allAssets, id]);
  const mission = missions.find((m) => m.id === id);
  const missionWaypoints = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );

  const [params, setParams] = useState<RouteParams>({ ...DEFAULT_ROUTE_PARAMS });
  const [savedText, setSavedText] = useState('');
  const [error, setError] = useState('');
  const [mergeHint, setMergeHint] = useState('');
  // 是否已做过本地加载，避免跨页 resync 把用户正在调的滑块覆盖掉
  const hydrated = useRef(false);
  const metrics = useRouteMetrics(id, params);

  // 进入页面 / 切换任务时，用已合并的航线参数与航点航高初始化面板
  useEffect(() => {
    hydrated.current = false;
    if (!id || !line) return;
    setParams((prev) => ({
      ...prev,
      altitude: missionWaypoints[0]?.altitude ?? prev.altitude,
      speed: missionWaypoints[0]?.speed ?? prev.speed,
      overlapForward: line.overlapForward,
      overlapSide: line.overlapSide,
      heading: line.heading,
    }));
    setSavedText(`上次保存：${new Date(line.updatedAt).toLocaleString('zh-CN')}`);
    hydrated.current = true;
    // 只在任务切换或航线对象首次出现时灌一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, line?.id]);

  const onSave = async () => {
    if (!mission) return;
    const { conflictFields } = await saveLine(mission.id, params);
    const latest = useLineStore.getState().byMission(mission.id);
    if (latest) setSavedText(`已保存 ${new Date(latest.updatedAt).toLocaleString('zh-CN')}`);
    if (conflictFields.length > 0) {
      setMergeHint(
        `其他标签页同时改了 ${conflictFields.length} 项航线参数，双方底本不同已并排挂起；这些字段在你选定前未写回，其余改动已合入。`,
      );
      message.warning('有航线参数差异待选定，请到下方「合并差异」中处理');
    } else {
      setMergeHint('');
      message.success('航线参数已保存，相关成果影像已按新参数失效并重算');
    }
  };

  const onArchive = async () => {
    if (!mission) return;
    try {
      await archiveMission(mission.id);
      message.success('差异已清空、成果均有效，任务已归档');
    } catch (e) {
      if (e instanceof ArchiveBlockedError) {
        const parts: string[] = [];
        if (e.conflicts > 0) parts.push(`${e.conflicts} 项合并差异未选定`);
        if (e.staleAssets > 0) parts.push(`${e.staleAssets} 张成果影像失效待重算`);
        message.error(`还不能归档：${parts.join('，')}`);
      }
    }
  };

  const pickPoint = async (lng: number, lat: number) => {
    if (!mission) return;
    if (missionWaypoints.length >= 60) {
      setError('单任务航点上限为 60 个，请拆分架次');
      return;
    }
    const seq = missionWaypoints.length === 0 ? 1 : Math.max(...missionWaypoints.map((w) => w.seq)) + 1;
    await addWaypoint({
      missionId: mission.id,
      seq,
      lng: Number(lng.toFixed(6)),
      lat: Number(lat.toFixed(6)),
      altitude: params.altitude,
      speed: params.speed,
      heading: params.heading,
      gimbalPitch: -90,
      action: '拍照',
      hoverSec: 0,
    });
    setError('');
  };

  const lineRows: LineRow[] = [
    { key: 'gsd', label: '地面分辨率 GSD', value: `${metrics.gsd} cm/px` },
    { key: 'spacing', label: '航线间距', value: `${metrics.spacing} m` },
    { key: 'interval', label: '拍照间隔', value: `${metrics.photoInterval} m` },
    { key: 'photos', label: '预计张数', value: `${metrics.estPhotos} 张` },
    { key: 'duration', label: '预计耗时', value: `${metrics.estDuration} min` },
    { key: 'battery', label: '预计电池组数', value: `${metrics.batteryCount} 组` },
    { key: 'area', label: '测区面积', value: `${metrics.area.toFixed(0)} m²` },
    { key: 'length', label: '航带路径长度', value: `${metrics.pathLength.toFixed(1)} m` },
    { key: 'lines', label: '预计航带数', value: `${metrics.lineCount} 条` },
  ];

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务（可能已被删除）" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  const previewLine: FlightLine = {
    id: line?.id ?? 'preview',
    missionId: mission.id,
    lineNo: 1,
    spacing: metrics.spacing,
    photoInterval: metrics.photoInterval,
    overlapForward: params.overlapForward,
    overlapSide: params.overlapSide,
    gsd: metrics.gsd,
    estPhotos: metrics.estPhotos,
    estDuration: metrics.estDuration,
    batteryCount: metrics.batteryCount,
    heading: params.heading,
    updatedAt: line?.updatedAt ?? Date.now(),
    rev: line?.rev ?? 1,
  };

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          航线规划 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag>{mission.areaName}</Tag>
        <Tag color={missionWaypoints.length > 0 ? 'green' : 'default'}>航点 {missionWaypoints.length} 个</Tag>
        {line ? <Tag color="geekblue">航线参数 v{line.rev}</Tag> : null}
        {staleAssets.length > 0 ? <Tag color="volcano">成果失效重算中 {staleAssets.length} 张</Tag> : null}
        <div style={{ flex: 1 }} />
        <Popconfirm title="归档该任务？" description="需先清空全部合并差异并等待成果重算完成" onConfirm={onArchive}>
          <Button disabled={mission.status === '已归档'}>归档任务</Button>
        </Popconfirm>
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/assets`}>成果编目</Link>
        </Button>
        <Button type="link">
          <Link to="/settings/camera">相机预设</Link>
        </Button>
        <Button type="link">
          <Link to="/missions">返回台账</Link>
        </Button>
      </Space>

      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {mergeHint ? <Alert type="warning" showIcon message={mergeHint} closable onClose={() => setMergeHint('')} /> : null}
      {staleAssets.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`航线参数已改动，${staleAssets.length} 张成果影像已立刻失效，正在按新参数重算 GSD / 重叠度 / 航高…`}
        />
      ) : null}

      <MergeConflictsCard missionId={mission.id} title="航线 / 航点 / 成果的合并差异" />

      <Row gutter={14}>
        <Col span={15}>
          <Card size="small" title="测区与航线">
            <AmapRouteView
              mission={mission}
              waypoints={missionWaypoints}
              altitude={params.altitude}
              height={440}
              onPickPoint={pickPoint}
            />
          </Card>
          <Card size="small" title="航线参数明细" style={{ marginTop: 14 }}>
            <Table<LineRow>
              rowKey="key"
              size="small"
              columns={lineColumns}
              dataSource={lineRows}
              pagination={false}
            />
          </Card>
          <Card size="small" title="多架次拆分" style={{ marginTop: 14 }}>
            <Space wrap size={6}>
              {splitSorties(previewLine).map((s) => (
                <Tag key={s.sortie} color="blue">
                  第 {s.sortie} 架次 · {s.photos} 张 · {s.durationMin} min
                </Tag>
              ))}
            </Space>
          </Card>
        </Col>
        <Col span={9}>
          <OverlapCalcPanel
            params={params}
            onChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
            metrics={metrics}
            onSave={onSave}
            savedText={savedText}
          />
        </Col>
      </Row>

      <Card size="small" title="点击网格新增的航点">
        {missionWaypoints.length === 0 ? (
          <Typography.Text type="secondary">
            暂无航点：在地图/网格上单击即可按当前航高新增航点，或到「航点明细」页批量粘贴导入。
          </Typography.Text>
        ) : (
          <Space wrap size={6}>
            {missionWaypoints.map((w: Waypoint) => (
              <Tag key={w.id} color={w.action === '悬停' ? 'gold' : 'blue'}>
                #{w.seq} {w.lng.toFixed(5)}, {w.lat.toFixed(5)} · {w.altitude} m · {w.action}
              </Tag>
            ))}
          </Space>
        )}
      </Card>
    </Space>
  );
}
