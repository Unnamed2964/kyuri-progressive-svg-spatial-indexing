# progressive-svg-spatial-indexing

> **以下内容暂时是 GPT 5.4 生成，暂未检查**

一个第一版的 TypeScript 库，用来把 SVG DOM 中被选中的图形元素增量同步到任意空间索引适配器中。

控制器直接附着到某个具体的 SVG layer/root element，而不是默认扫描整个 svg。这样宿主应用可以把需要被索引的元素集中渲染在单独层中，减少无关节点遍历和失效传播成本。

这个 layer 不是任意容器，而是索引 layer：控制器只跟踪它的第一层子元素，每个第一层图元都应该代表一个完整的可索引业务对象。

## 当前范围

- 监听 SVG 子树中的新增、删除、属性变化与文本变化
- 维护命中元素的世界坐标 AABB
- 以 requestAnimationFrame 为批处理边界进行测量和批量 upsert/remove
- 将查询请求转发给外部提供的空间索引适配器
- 提供手动失效与立即 flush 能力
- 允许直接附着到单独的 layer/group 元素，只同步该 layer 的第一层图元

## 第一层子元素约定

`attach(rootElement)` 中的 `rootElement` 必须是专门用于索引的 layer。控制器只会跟踪它的第一层子元素，不会递归筛选更深层的后代节点。

推荐把每个需要索引的业务对象渲染成该 layer 下的一个直接子元素，通常是一个 `<g>` 或单个图形元素。这个直接子元素内部可以自由包含更深的 SVG 结构，但控制器会把整个直接子元素视为一个索引单元。

如果内部后代变化会影响这个直接子元素的最终几何，控制器会在观察到对应 DOM 变化后重新测量它。手动失效 API 也以第一层图元为单位：可以对单个图元调用 `invalidateElement()`，或对某个容器的直接图元调用 `invalidateChildren()`。

## Layer 约定

推荐把需要空间索引的图元集中渲染在一个单独的 SVG layer/group 中，并把控制器直接 attach 到这个 layer。这样控制器只会观察和扫描该 layer 的第一层子元素，而不会遍历同一个 svg 中的其他 UI、装饰或编辑辅助层。

## 内置适配器

- 提供一个基于 rbush 的适配器实现，可直接作为第一版空间索引后端
- 核心库仍然只依赖 SpatialIndexAdapter 抽象，后续可以替换为其他实现

## 不负责的内容

- 空间索引具体数据结构
- 最近邻查询与贴靠精算
- 业务对象模型与撤销逻辑

## 安装

```bash
npm install
```

## 测试

```bash
npm test
```

## 构建

```bash
npm run build
```