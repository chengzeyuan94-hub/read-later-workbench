import { clone, validateBundle, type WorkspaceBundle } from './model.js';

/** Explicit, bounded synthetic load samples. Never reads a collection or copies an asset. */
export function scaleFixture(original: WorkspaceBundle, count: number): WorkspaceBundle {
  if (![12, 100, 300].includes(count)) throw new Error('Synthetic node count must be 12, 100 or 300');
  const bundle = clone(original);
  const prefix = bundle.workspace.id.replace(/-workspace$/, '');
  if (Object.keys(bundle.map.nodes).length !== 12) throw new Error('Scale fixture requires the original twelve-node fixture');
  bundle.map.nodes[`${prefix}-n9`].title = [{ text: '长中文标题与 emoji 👩🏽‍💻：文字换行后的节点尺寸需要实际测量，不能使用固定行高\n第二行保留来源按钮与相邻节点间距。' }];
  for (let n = 13; n <= count; n++) {
    const id = `${prefix}-n${n}`;
    const parentId = n < 25 ? `${prefix}-n${2 + (n % 3)}` : `${prefix}-n${13 + Math.floor((n - 25) / 4)}`;
    const image = n % 11 === 0 ? clone(bundle.map.nodes[`${prefix}-n10`].image) : undefined;
    bundle.map.nodes[id] = {
      id, parentId, children: [],
      title: [{ text: n % 7 === 0 ? `合成长标题 ${n} 🧠\n中文与 emoji 👩🏽‍💻跨行测量：图片、文字、来源按钮不互相覆盖，排序移动仍保留身份。` : `合成节点 ${n} 📚` }],
      notes: `E0.1 ${count} 节点合成样本；不是用户收藏。`,
      sourceRefs: n % 13 === 0 ? clone(bundle.map.nodes[`${prefix}-n11`].sourceRefs) : [],
      ...(image ? { image } : {}),
    };
    bundle.map.nodes[parentId].children.push(id);
  }
  validateBundle(bundle);
  return bundle;
}
