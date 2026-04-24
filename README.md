# progressive-svg-spatial-indexing

一个第一版的 TypeScript 库，用来把 SVG DOM 中被选中的图形元素增量同步到任意空间索引适配器中。

## 当前范围

- 监听 SVG 子树中的新增、删除、属性变化与文本变化
- 维护命中元素的世界坐标 AABB
- 以 requestAnimationFrame 为批处理边界进行测量和批量 upsert/remove
- 将查询请求转发给外部提供的空间索引适配器
- 提供手动失效与立即 flush 能力

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