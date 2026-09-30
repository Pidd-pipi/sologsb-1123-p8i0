import { Button, Card, Empty, Space, Tag, Typography, message } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { useConflictStore } from '../../stores/conflictStore';
import { formatConflictValue, MERGE_KIND_LABELS, MERGE_FIELD_META, type MergeConflict, type MergeKind } from '../../types/merge';
import { TAB_ID } from '../../utils/tabId';

export interface MergeConflictsCardProps {
  /** 限定任务；不传则展示全部待决差异（全局合并中心用） */
  missionId?: string;
  title?: string;
  /** 无差异时是否仍渲染空状态卡片；默认无差异直接不占位 */
  showWhenEmpty?: boolean;
  onResolved?: (kind: MergeKind, resolvedMissionId: string) => void;
}

const KIND_COLOR: Record<MergeKind, string> = {
  waypoint: 'blue',
  line: 'geekblue',
  asset: 'purple',
};

/**
 * 合并差异清单：底本不同时把双方值并排列出，用户选定一方才写回。
 * 被航线规划页、航点明细页、成果编目页以及顶部「合并中心」抽屉复用。
 */
export default function MergeConflictsCard({ missionId, title = '待选定的合并差异', showWhenEmpty = false, onResolved }: MergeConflictsCardProps) {
  const all = useConflictStore((s) => s.items);
  const resolve = useConflictStore((s) => s.resolve);
  const list = (missionId ? all.filter((c) => c.missionId === missionId) : all).sort((a, b) => a.updatedAt - b.updatedAt);

  const choose = async (conflict: MergeConflict, side: 'local' | 'remote') => {
    const result = await resolve(conflict.id, side);
    if (result.ok) {
      const fieldLabel = MERGE_FIELD_META[conflict.kind][conflict.field]?.label ?? conflict.field;
      message.success(`已采用${side === 'local' ? '本页' : '他页'}值写回 ${conflict.objectLabel}·${fieldLabel}`);
      onResolved?.(result.kind ?? conflict.kind, result.missionId ?? conflict.missionId);
    }
  };

  if (list.length === 0 && !showWhenEmpty) return null;

  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <span>{title}</span>
          <Tag color="volcano">{list.length} 项待清</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            选定前任一方值都不会写回；差异清完才能归档
          </Typography.Text>
        </Space>
      }
      data-testid="merge-conflicts-card"
    >
      {list.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待选定的差异，各标签页数据已一致" />
      ) : (
        <Space direction="vertical" size={0} style={{ width: '100%' }}>
          {list.map((c, index) => {
            const isLocalMine = c.localTabId === TAB_ID;
            const localTag = isLocalMine ? '本页' : c.localTabId || '他页';
            const remoteTag =
              c.remoteTabId && c.remoteTabId !== TAB_ID ? c.remoteTabId : c.remoteTabId === TAB_ID ? '本页' : '他页';
            const fieldLabel = MERGE_FIELD_META[c.kind][c.field]?.label ?? c.field;
            return (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 0',
                  borderTop: index === 0 ? undefined : '1px solid #f0f0f0',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 300, flex: 1 }}>
                  <Space size={6} wrap style={{ marginBottom: 4 }}>
                    <Tag color={KIND_COLOR[c.kind]}>{MERGE_KIND_LABELS[c.kind]}</Tag>
                    <span>{c.objectLabel}</span>
                    <Tag>{fieldLabel}</Tag>
                  </Space>
                  <Space size={12} wrap align="start">
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {localTag}（{c.localTabId || '未知页'}）
                      </Typography.Text>
                      <div>
                        <Tag color="blue">{formatConflictValue(c.kind, c.field, c.localValue)}</Tag>
                      </div>
                    </div>
                    <Typography.Text type="success">⇄</Typography.Text>
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {remoteTag}（{c.remoteTabId || '先写入的一页'}）· 当前库内
                      </Typography.Text>
                      <div>
                        <Tag color="green">{formatConflictValue(c.kind, c.field, c.remoteValue)}</Tag>
                      </div>
                    </div>
                  </Space>
                </div>
                <Space direction="vertical" size={4}>
                  <Button size="small" type="primary" ghost icon={<CheckOutlined />} onClick={() => choose(c, 'local')}>
                    采用左值（{localTag}）
                  </Button>
                  <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => choose(c, 'remote')}>
                    采用右值（{remoteTag}）
                  </Button>
                </Space>
              </div>
            );
          })}
        </Space>
      )}
    </Card>
  );
}
