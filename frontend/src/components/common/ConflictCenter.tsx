import { useMemo, useState } from 'react';
import { Badge, Button, Drawer, Empty, Space, Tag, Typography } from 'antd';
import { MergeCellsOutlined } from '@ant-design/icons';
import { useConflictStore } from '../../stores/conflictStore';
import { useMissionStore } from '../../stores/missionStore';
import MergeConflictsCard from './MergeConflictsCard';

/** 顶栏「合并中心」：徽标显示全任务待决差异数，抽屉里按任务分组列出 */
export default function ConflictCenter() {
  const conflicts = useConflictStore((s) => s.items);
  const missions = useMissionStore((s) => s.items);
  const [open, setOpen] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<string, number>();
    conflicts.forEach((c) => map.set(c.missionId, (map.get(c.missionId) ?? 0) + 1));
    return Array.from(map.entries()).map(([missionId, count]) => ({
      missionId,
      count,
      mission: missions.find((m) => m.id === missionId),
    }));
  }, [conflicts, missions]);

  return (
    <>
      <Badge count={conflicts.length} size="small" offset={[-6, 4]}>
        <Button
          size="small"
          icon={<MergeCellsOutlined />}
          onClick={() => setOpen(true)}
          danger={conflicts.length > 0}
          data-testid="conflict-center-button"
        >
          合并中心
        </Button>
      </Badge>
      <Drawer
        title={
          <Space>
            <MergeCellsOutlined />
            <span>多标签合并中心</span>
            {conflicts.length > 0 ? <Tag color="volcano">{conflicts.length} 项差异待选定</Tag> : null}
          </Space>
        }
        open={open}
        width={680}
        onClose={() => setOpen(false)}
      >
        {groups.length === 0 ? (
          <Empty description="所有标签页的数据已合并一致" />
        ) : (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              同一条航拍任务在多个标签页被改动时，底本不同的对象字段会并排列出双方值；请逐项选定后写回。
            </Typography.Paragraph>
            {groups.map((g) => (
              <MergeConflictsCard
                key={g.missionId}
                missionId={g.missionId}
                title={`${g.mission?.missionNo ?? '已删除任务'} · ${g.mission?.areaName ?? '—'}（${g.count} 项）`}
              />
            ))}
          </Space>
        )}
      </Drawer>
    </>
  );
}
