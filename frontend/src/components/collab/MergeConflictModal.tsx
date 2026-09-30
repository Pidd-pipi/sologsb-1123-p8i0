import { useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, Modal, Radio, Space, Tag, Typography, Divider } from 'antd';
import { MergeCellsOutlined } from '@ant-design/icons';
import { useWaypointStore } from '../../stores/waypointStore';
import { useLineStore } from '../../stores/lineStore';
import { useAssetStore } from '../../stores/assetStore';
import { useCollabStore } from '../../stores/collabStore';
import {
  FIELD_DEFS,
  OBJECT_TYPE_LABEL,
  formatFieldValue,
  type FieldConflict,
  type ObjectType,
} from '../../utils/merge';

const { Text } = Typography;

interface ObjectGroup {
  key: string;
  objectType: ObjectType;
  objectId: string;
  missionId: string;
  conflicts: FieldConflict[];
}

/** 取对象在合并结果中的展示名（航点用 #seq，成果用片号，航线参数固定名） */
function useObjectLabel(objectType: ObjectType, objectId: string): string {
  const waypoints = useWaypointStore((s) => s.items);
  const assets = useAssetStore((s) => s.items);
  if (objectType === 'waypoint') {
    const w = waypoints.find((it) => it.id === objectId);
    return w ? `航点 #${w.seq}` : '航点';
  }
  if (objectType === 'asset') {
    const a = assets.find((it) => it.id === objectId);
    return a ? `成果 ${a.imageNo}` : '成果影像';
  }
  return '航线参数';
}

function ValueColumn({ title, value, tone }: { title: string; value: string; tone: 'base' | 'local' | 'remote' }) {
  const color = tone === 'local' ? '#1677ff' : tone === 'remote' ? '#d46b08' : '#8c8c8c';
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, color, marginBottom: 2 }}>{title}</div>
      <div
        style={{
          fontSize: 13,
          padding: '4px 8px',
          borderRadius: 4,
          background: tone === 'base' ? '#fafafa' : tone === 'local' ? '#e6f4ff' : '#fff7e6',
          border: `1px solid ${tone === 'base' ? '#f0f0f0' : tone === 'local' ? '#91caff' : '#ffd591'}`,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ConflictRow({ conflict, onResolve }: { conflict: FieldConflict; onResolve: (choice: 'local' | 'remote') => void }) {
  const def = FIELD_DEFS[conflict.objectType].find((d) => d.key === conflict.field);
  const isDelete = conflict.field === '__delete__';

  if (isDelete) {
    const remoteWantsDelete = conflict.remote === null;
    return (
      <div style={{ padding: '8px 0', borderBottom: '1px dashed #f0f0f0' }}>
        <Space wrap align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space direction="vertical" size={2}>
            <Text strong>{conflict.fieldLabel}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {remoteWantsDelete ? '对方删除了该对象，而本方有修改' : '本方删除了该对象，而对方有修改'}
            </Text>
          </Space>
          <Radio.Group size="small" onChange={(e) => onResolve(e.target.value as 'local' | 'remote')}>
            <Radio.Button value="local">{remoteWantsDelete ? '保留本方修改' : '按本方删除'}</Radio.Button>
            <Radio.Button value="remote">{remoteWantsDelete ? '按对方删除' : '保留对方修改'}</Radio.Button>
          </Radio.Group>
        </Space>
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 0', borderBottom: '1px dashed #f0f0f0' }}>
      <Space wrap align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text strong style={{ minWidth: 90 }}>{conflict.fieldLabel}</Text>
        <div style={{ display: 'flex', gap: 8, flex: 1, minWidth: 260 }}>
          <ValueColumn title="底本" value={formatFieldValue(def, conflict.base)} tone="base" />
          <ValueColumn title="本方" value={formatFieldValue(def, conflict.local)} tone="local" />
          <ValueColumn title="对方" value={formatFieldValue(def, conflict.remote)} tone="remote" />
        </div>
        <Radio.Group size="small" onChange={(e) => onResolve(e.target.value as 'local' | 'remote')}>
          <Radio.Button value="local">采用本方</Radio.Button>
          <Radio.Button value="remote">采用对方</Radio.Button>
        </Radio.Group>
      </Space>
    </div>
  );
}

function ObjectConflictCard({ group }: { group: ObjectGroup }) {
  const resolveWaypoint = useWaypointStore((s) => s.resolveConflict);
  const resolveLine = useLineStore((s) => s.resolveConflict);
  const resolveAsset = useAssetStore((s) => s.resolveConflict);
  const label = useObjectLabel(group.objectType, group.objectId);

  const resolve = (conflictKey: string, choice: 'local' | 'remote') => {
    if (group.objectType === 'waypoint') void resolveWaypoint(conflictKey, choice);
    else if (group.objectType === 'line') void resolveLine(conflictKey, choice);
    else void resolveAsset(conflictKey, choice);
  };

  const resolveAll = async (choice: 'local' | 'remote') => {
    // 逐个 await，避免同一对象的多处冲突并发写导致后写覆盖先写
    for (const c of group.conflicts) {
      if (group.objectType === 'waypoint') await resolveWaypoint(c.key, choice);
      else if (group.objectType === 'line') await resolveLine(c.key, choice);
      else await resolveAsset(c.key, choice);
    }
  };

  return (
    <Card
      size="small"
      title={
        <Space size={6}>
          <Tag color="blue">{OBJECT_TYPE_LABEL[group.objectType]}</Tag>
          <Text>{label}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {group.conflicts.length} 处差异
          </Text>
        </Space>
      }
      extra={
        <Space size={4}>
          <Button size="small" onClick={() => resolveAll('local')}>
            本对象全选本方
          </Button>
          <Button size="small" onClick={() => resolveAll('remote')}>
            本对象全选对方
          </Button>
        </Space>
      }
      style={{ marginBottom: 12 }}
    >
      {group.conflicts.map((c) => (
        <ConflictRow key={c.key} conflict={c} onResolve={(choice) => resolve(c.key, choice)} />
      ))}
    </Card>
  );
}

/** 合并冲突弹窗：底本不同就并排列出双方值，选定前不写回；其余改动已自动合入 */
export default function MergeConflictModal() {
  const open = useCollabStore((s) => s.conflictModalOpen);
  const missionId = useCollabStore((s) => s.conflictMissionId);
  const close = useCollabStore((s) => s.closeConflictModal);

  const wpConflicts = useWaypointStore((s) => s.conflicts);
  const lineConflicts = useLineStore((s) => s.conflicts);
  const assetConflicts = useAssetStore((s) => s.conflicts);
  const resolveWaypoint = useWaypointStore((s) => s.resolveConflict);
  const resolveLine = useLineStore((s) => s.resolveConflict);
  const resolveAsset = useAssetStore((s) => s.resolveConflict);

  const conflicts = useMemo(() => {
    const all = [...wpConflicts, ...lineConflicts, ...assetConflicts];
    return missionId ? all.filter((c) => c.missionId === missionId) : all;
  }, [wpConflicts, lineConflicts, assetConflicts, missionId]);

  const groups = useMemo(() => {
    const map = new Map<string, ObjectGroup>();
    conflicts.forEach((c) => {
      const key = `${c.objectType}:${c.objectId}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          objectType: c.objectType,
          objectId: c.objectId,
          missionId: c.missionId,
          conflicts: [],
        });
      }
      map.get(key)!.conflicts.push(c);
    });
    return Array.from(map.values());
  }, [conflicts]);

  const resolveAll = async (choice: 'local' | 'remote') => {
    for (const c of conflicts) {
      if (c.objectType === 'waypoint') await resolveWaypoint(c.key, choice);
      else if (c.objectType === 'line') await resolveLine(c.key, choice);
      else await resolveAsset(c.key, choice);
    }
  };

  const total = conflicts.length;

  return (
    <Modal
      title={
        <Space>
          <MergeCellsOutlined />
          <span>合并差异 · 按对象解决冲突</span>
          {total > 0 ? <Tag color="red">{total} 处待选</Tag> : <Tag color="green">已结清</Tag>}
        </Space>
      }
      open={open}
      onCancel={close}
      width={860}
      footer={
        <Space>
          <Button onClick={close}>关闭</Button>
          <Button disabled={total === 0} onClick={() => resolveAll('local')}>
            全部采用本方
          </Button>
          <Button type="primary" disabled={total === 0} onClick={() => resolveAll('remote')}>
            全部采用对方
          </Button>
        </Space>
      }
    >
      {total === 0 ? (
        <Empty description="没有未解决的合并差异" />
      ) : (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="双方都改动了同一对象的同一字段。底本为共同起点，本方是本标签页的值，对方是其他标签页写入的值。请为每处选择保留哪一方；未选择前不会写回。其余不冲突的改动已照常自动合入。"
          />
          {groups.map((g) => (
            <ObjectConflictCard key={g.key} group={g} />
          ))}
        </>
      )}
      <Divider style={{ margin: '8px 0 0' }} />
    </Modal>
  );
}
