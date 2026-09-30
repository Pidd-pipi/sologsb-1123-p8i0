# sologsb-1123 无人机航拍航线与成果编目台（gbdronemap）

面向航拍作业与测绘内业人员：先按测区规划航线与航点（重叠率、相对航高、地面分辨率），再对飞行产出的成果影像逐张编目（片号、GSD、重叠度、质量）。范围只覆盖**航线规划**与**成果影像编目**本身。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21823**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 地图 | 高德地图 JS API 2.0（可选，key 缺失时自动退化） |
| 本地存储 | IndexedDB（Dexie 4），缩略图单独建表，含结构版本号与升级迁移 |

## VITE_AMAP_KEY 配置与退化行为（重要）

- key 从环境变量 `VITE_AMAP_KEY` 读取（`.env` / `.env.example` 中已留空）。
- **未配置 key（默认）**：`<AmapRouteView>` 自动渲染**本地 SVG 网格视图**——按经纬度等比投影，仍可绘制测区边界、航点折线、每个航点的视场矩形，并支持**点击网格新增航点**。此模式下页面**不发起任何外部网络请求**。
- **配置了 key**：动态加载 `https://webapi.amap.com/maps?v=2.0&key=...`，用高德地图绘制多边形 / 折线 / 航点 / 视场矩形。
- **构建与运行都不依赖该 key**：`vite.config.ts` 与 Dockerfile 均不校验 key；即使填了 key 但脚本加载失败或 8 s 超时，也会自动退化为 SVG 网格视图，页面顶部用 `Alert` 标明当前模式。

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite build
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1123/
├── docker-compose.yml
├── .env.example           # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── index.css
        ├── vite-env.d.ts
        ├── router/index.tsx
        ├── types/{mission,waypoint,flightline,imageasset,merge}.ts
        ├── stores/{mission,waypoint,asset,line,conflict}Store.ts
        ├── components/common/{AmapRouteView,OverlapCalcPanel,AssetGrid,MissionCard,MergeConflictsCard,ConflictCenter}.tsx
        ├── hooks/{useMissionFilter,useRouteMetrics,useCrossTabSync}.ts
        ├── pages/{MissionList,RoutePlanner,WaypointTable,AssetCatalog,CameraPreset}.tsx
        └── utils/{db,geoCalc,amapLoader,id,merge,lineMetrics,assetSync,syncBus,tabId}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/missions` | 任务台账：按测区/机型/飞行日期区间/状态筛选，显示航线数、预计张数与成果条目数 | Mission |
| `/missions/:id/route` | 航线规划主视图：地图/网格绘制测区与航点折线，右侧参数面板改航高/航速/重叠率，实时回算 GSD、航线间距、预计张数与耗时 | Mission、Waypoint、FlightLine |
| `/missions/:id/waypoints` | 航点明细：经纬度粘贴导入、批量改高度、上下移与拖拽换序、单点视场预览 | Waypoint |
| `/missions/:id/assets` | 成果影像编目：卡片格子列出片号/缩略图/GSD/质量，多选标记质量、定位到图、导出清单 | ImageAsset |
| `/settings/camera` | 相机与传感器参数预设管理，选定预设后带入任务的焦距/像元/传感器 | CameraPreset、Mission |

`/` 重定向到 `/missions`，未匹配路由同样兜底到 `/missions`。

## 关键算法

- **地面分辨率**：`GSD(cm/px) = 像元尺寸(μm) × 航高(m) / (焦距(mm) × 10)`
- **地面幅宽**：`幅宽(m) = 传感器尺寸(mm) × 航高(m) / 焦距(mm)`
- **航线间距** = 旁向幅宽 × (1 − 旁向重叠率)；**拍照间隔** = 航向幅宽 × (1 − 航向重叠率)
- **预计张数** = Σ(每条航带长度 / 拍照间隔 + 1)；**预计耗时** = (总航程 / 航速 + 转弯与悬停附加) / 60；**电池组数** 按 20 min 有效续航向上取整
- **测区面积**：经纬度投影到米制后用鞋带公式；**航带路径长度**：逐段球面近似距离累加

## 多标签页合并（同一条任务被多页修改）

同一条航拍任务常在多个浏览器标签页里同时编辑，各页**不会再互相覆盖**：

- **按对象三方合并**：航点、航线参数、成果影像各带合并版本号 `rev`。保存时与本页底本逐字段比对——本页没动的字段采用他页值、双方改了不同字段各自合入；**底本不同（双方改了同一字段且取值不同）时，把双方值并排列入「合并差异」台账，用户选定任一方前该字段不写回**，库内先保留先写入一方的值。
- **差异选定**：每个相关页面（航线规划 / 航点明细 / 成果编目）顶部都有差异卡片，顶栏「合并中心」按任务汇总全部待决项；点「采用左值 / 采用右值」才落库。双方改成同一值会自动消解。
- **成果失效与重算**：航线参数（重叠率 / 航高 / 航向）或相机传感器保存后，该任务的成果影像**立刻置为「失效重算」**（片号、坐标、质量等人工编目保留），随后按最新航点与航线重算 GSD / 重叠度 / 航高 / 倾角；航线派生量（间距、张数、耗时等）随差异选定一并回算。
- **归档闸口**：任务归档前必须满足「合并差异全部清完」且「没有失效待重算的成果」，否则拒绝并提示剩余数量。
- **同一版本**：任一标签页写库后通过 BroadcastChannel（不可用时退化为 `localStorage` storage 事件）通知各页从 IndexedDB 重新拉取；切回标签页 / 窗口重新聚焦时也会兜底重拉。台账、规划页、编目页读的都是同一份合并结果。
- 同页对同一对象的连续快速编辑（如连续点步进器）经串行写队列处理，不会丢更新。

## 数据存储说明

- 数据库名 `gbdronemap`，当前结构版本 **v3**（`localStorage['gbdronemap:db-version']` 记录）。
- 七张表：`missions`（任务）、`waypoints`（航点，含 `rev`）、`lines`（航线参数，含 `rev`）、`assets`（成果影像条目，含 `rev` / `stale` / `lineRev`）、`thumbs`（**缩略图单独建表**，dataUrl）、`presets`（相机预设）、`conflicts`（多标签合并差异台账）。
- v2 → v3 迁移：为航点 / 航线 / 成果补合并版本号 `rev=1`，为成果补 `stale=false` / `lineRev=0`，并新增 `conflicts` 表与相关索引。
- v1 → v2 迁移：为老任务补 `areaPolygon`/传感器默认值，为航线补 `updatedAt`/`batteryCount`，并新增索引。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范任务、5 个航点、2 条航线参数、6 条成果影像条目（含缩略图）与 3 套相机预设。
