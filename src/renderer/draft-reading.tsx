import React from 'react';
import { listItemDisplayRuns, isSafeLink, type AssetRef, type DraftBlock, type DraftDocument, type TextRun } from '../editor-core/model.js';

/** A matching block string cannot prove the provenance of a different saved version. */
export function exactDraftReferenceVersion(current:DraftDocument,saved?:DraftDocument):boolean{return !!saved&&JSON.stringify(current)===JSON.stringify(saved);}

function ReadingRuns({ runs }: { runs: TextRun[] }) {
  return <>{runs.map((run, index) => {
    let content: React.ReactNode = run.text;
    if (run.code) content = <code>{content}</code>;
    if (run.bold) content = <strong>{content}</strong>;
    if (run.italic) content = <em>{content}</em>;
    // Reading never navigates the renderer or starts a model call.
    if (run.href && isSafeLink(run.href)) content = <span title={run.href} className="e3-readable-link">{content}</span>;
    return <React.Fragment key={index}>{content}</React.Fragment>;
  })}</>;
}
/** Read view derives from the exact structured document used by editing/export. */
export function DraftReading({ blocks, assetUrl, onReference }: { blocks: DraftBlock[]; assetUrl(ref: AssetRef): string; onReference?(blockId: string): void }) {
  const block = (item: DraftBlock, displayRuns?: TextRun[]): React.ReactNode => {
    const children = item.type === 'bulletList' || item.type === 'orderedList'
      ? item.children?.map((child, index) => {
        const ordinal = (item.start ?? 1) + index;
        return <li key={child.id}>{child.children?.map((paragraph, childIndex) => block(paragraph, childIndex === 0 && paragraph.type === 'paragraph' ? listItemDisplayRuns(paragraph.runs, item.type as 'bulletList' | 'orderedList', ordinal) : undefined))}</li>;
      })
      : item.children?.map(child => block(child));
    const runs = <ReadingRuns runs={displayRuns ?? item.runs} />;
    const body = item.type === 'heading' ? React.createElement(`h${item.level || 1}`, null, runs)
      : item.type === 'bulletList' ? <ul>{children}</ul>
      : item.type === 'orderedList' ? <ol start={item.start}>{children}</ol>
      : item.type === 'listItem' ? <li>{children}</li>
      : item.type === 'blockquote' ? <blockquote>{children}</blockquote>
      : item.type === 'image' ? <figure><img src={assetUrl(item.assetRefs![0])} alt="文稿使用的本地图片" onError={event => { event.currentTarget.hidden = true; event.currentTarget.parentElement?.setAttribute('data-asset-error', 'true'); }} /><figcaption>本地图片{onReference && <button onClick={() => onReference(item.id)}>出处</button>}</figcaption></figure>
      : <p>{runs}</p>;
    // List children must remain direct li elements; no wrapper is inserted.
    return <React.Fragment key={item.id}>{body}{onReference && !['bulletList', 'orderedList', 'listItem', 'blockquote', 'image'].includes(item.type) && <button className="e3-block-source" aria-label="查看本段出处" onClick={() => onReference(item.id)}>出处</button>}</React.Fragment>;
  };
  return <article className="e3-draft-reading" aria-label="文稿阅读预览">{blocks.map(item => block(item))}</article>;
}
