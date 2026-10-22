import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node } from 'prosemirror-model';
import { plainText, redundantListPrefixLength, type TextRun } from '../editor-core/model.js';

/** Width affects measured layout only, never saved text, identity or map history. */
export function nodePresentationWidth(title: TextRun[]): number {
  const longestLine = plainText(title).split('\n').reduce((maximum, line) => Math.max(maximum, Array.from(line).length), 0);
  return longestLine > 42 ? 284 : longestLine > 24 ? 248 : 194;
}

/** Keep literal text editable. Hide only the redundant native list marker. */
export function redundantListMarkerDecorations(doc: Node): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!['bulletList', 'orderedList'].includes(node.type.name)) return;
    let offset = 0;
    node.forEach((item, _offset, index) => {
      const first = item.firstChild;
      if (item.type.name === 'listItem' && first?.type.name === 'paragraph') {
        const runs: TextRun[] = [];
        first.forEach(child => { if (child.isText) runs.push({ text: child.text ?? '', code: child.marks.some(mark => mark.type.name === 'code' && mark.attrs.enabled !== false) || undefined, href: child.marks.find(mark => mark.type.name === 'link')?.attrs.href }); else runs.push({ text: '\n' }); });
        const kind = node.type.name as 'bulletList' | 'orderedList';
        if (redundantListPrefixLength(runs, kind, Number(node.attrs.start ?? 1) + index)) decorations.push(Decoration.node(pos + 1 + offset, pos + 1 + offset + item.nodeSize, { class: 'e41-literal-list-marker' }));
      }
      offset += item.nodeSize;
    });
  });
  return DecorationSet.create(doc, decorations);
}
export function listPresentationPlugin(): Plugin {
  let previous: Node | null = null, decorations = DecorationSet.empty;
  return new Plugin({ props: { decorations: state => { if (state.doc !== previous) { previous = state.doc; decorations = redundantListMarkerDecorations(state.doc); } return decorations; } } });
}
