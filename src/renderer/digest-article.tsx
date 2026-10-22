import React, { useId, useState } from 'react';
import type { AssetRef, DraftBlock, MindMapNode, SourceReference, TextRun } from '../editor-core/model.js';
import { digestArticleVersions, digestImageAttachment, digestReferenceText, digestSafeLink, type ReadyDigestArtifact } from './digest-article-helpers.js';
import { useDevInfo } from './dev-info.js';
import { IconExternal } from './icons.js';
import './digest-article.css';

export interface DigestArticleProps { artifact: ReadyDigestArtifact; assetUrl(relativePath: string): string }
function ArticleRuns({ runs }: { runs: TextRun[] }) {
  return <>{runs.map((run, index) => {
    let text: React.ReactNode = run.text;
    if (run.code) text = <code>{text}</code>; if (run.italic) text = <em>{text}</em>; if (run.bold) text = <strong>{text}</strong>;
    const href = digestSafeLink(run.href); if (href) text = <a href={href} target="_blank" rel="noopener noreferrer">{text}</a>;
    return <span key={index} style={{ fontWeight: run.bold === false ? 400 : undefined, fontStyle: run.italic === false ? 'normal' : undefined, fontFamily: run.code === false ? 'inherit' : undefined }}>{text}</span>;
  })}</>;
}
function ArtifactImage({ image, artifact, assetUrl, label }: { image: AssetRef; artifact: ReadyDigestArtifact; assetUrl(relativePath: string): string; label: string }) {
  const [failed, setFailed] = useState(false), attachment = digestImageAttachment(image, artifact);
  if (!attachment) return <p className="digest-article-missing" role="status">{label}：这张固定图片未包含在本成稿附件清单中，未补取其他版本。</p>;
  if (failed) return <p className="digest-article-missing" role="status">{label}：固定图片附件无法读取，未回退到网络图片。</p>;
  return <figure className="digest-article-image"><img src={assetUrl(attachment.relativePath)} alt={label} loading="lazy" onError={() => setFailed(true)} /><figcaption>{label}</figcaption></figure>;
}
/** Render canonical, validated block semantics. Markdown HTML is never executed. */
function ArticleBlock({ block, artifact, assetUrl }: { block: DraftBlock; artifact: ReadyDigestArtifact; assetUrl(relativePath: string): string }): React.ReactNode {
  const children = block.children?.map(child => <ArticleBlock key={child.id} block={child} artifact={artifact} assetUrl={assetUrl} />), runs = <ArticleRuns runs={block.runs} />;
  const images = block.assetRefs?.map((image, index) => <ArtifactImage key={`${image.assetId}@${image.version}`} image={image} artifact={artifact} assetUrl={assetUrl} label={`成稿图片 ${index + 1}`} />);
  if (block.type === 'heading') { const Tag = `h${Math.max(1, Math.min(3, block.level || 1))}` as 'h1' | 'h2' | 'h3'; return <><Tag data-artifact-block={block.id}>{runs}</Tag>{images}</>; }
  if (block.type === 'bulletList') return <ul data-artifact-block={block.id}>{children}</ul>;
  if (block.type === 'orderedList') return <ol start={block.start} data-artifact-block={block.id}>{children}</ol>;
  if (block.type === 'listItem') return <li data-artifact-block={block.id}>{children}</li>;
  if (block.type === 'blockquote') return <blockquote data-artifact-block={block.id}>{children}</blockquote>;
  if (block.type === 'image') return <div data-artifact-block={block.id}>{images}</div>;
  return <><p data-artifact-block={block.id}>{runs}</p>{images}</>;
}
function Reference({ refValue, artifact, assetUrl }: { refValue: SourceReference; artifact: ReadyDigestArtifact; assetUrl(relativePath: string): string }) {
  const resolved = digestReferenceText(refValue, artifact.bundle), assets = resolved.assets.filter((asset, index, all) => all.findIndex(other => other.assetId === asset.assetId && other.version === asset.version) === index);
  return <details className="digest-article-reference"><summary>{resolved.label}{resolved.unknownTime ? ' · 仅定位文字，句子时间未知' : ''}</summary>{resolved.exactInBundle ? <p className="digest-article-source-selection">{resolved.before}<mark>{resolved.selectedText}</mark>{resolved.after}</p> : <><p className="digest-article-note">该确切旧版本不在本成稿预览包中。保留原引用身份，回整理工作区可查看。</p>{resolved.selectedText && <blockquote>{resolved.selectedText}</blockquote>}</>}{assets.map(asset => <ArtifactImage key={`${asset.assetId}@${asset.version}`} image={asset} artifact={artifact} assetUrl={assetUrl} label="引用时图片" />)}{resolved.originalUrl && <a href={resolved.originalUrl} target="_blank" rel="noopener noreferrer">来源原链接 <IconExternal size={12} /></a>}</details>;
}
function OutlineNode({ node, artifact, assetUrl }: { node: MindMapNode; artifact: ReadyDigestArtifact; assetUrl(relativePath: string): string }) {
  return <li data-artifact-node={node.id}><p className="digest-article-node-title" style={{ fontWeight: node.style?.bold ? 700 : undefined, fontStyle: node.style?.italic ? 'italic' : undefined }}><ArticleRuns runs={node.title} /></p>{node.notes && <p className="digest-article-node-notes">{node.notes}</p>}{node.image && <ArtifactImage image={node.image} artifact={artifact} assetUrl={assetUrl} label="导图节点图片" />}{node.sourceRefs.map((refValue, index) => <Reference key={index} refValue={refValue} artifact={artifact} assetUrl={assetUrl} />)}{node.children.length > 0 && <ul>{node.children.map(id => <OutlineNode key={id} node={artifact.bundle.map.nodes[id]} artifact={artifact} assetUrl={assetUrl} />)}</ul>}</li>;
}
/** Read-only materialized result: never requests processing, changes a draft, or enters the library. */
export function DigestArticle({ artifact, assetUrl }: DigestArticleProps) {
  const versions = digestArticleVersions(artifact), headingId = useId(), devInfo = useDevInfo();
  if (!versions.consistent) return <section className="digest-article" role="alert"><p>成稿版本与固定正文／导图不一致，预览暂不可用。已保存资料保留。</p></section>;
  return <section className="digest-article" aria-labelledby={headingId} data-artifact-draft-revision={artifact.draftRevision} data-artifact-map-revision={artifact.mapRevision}><header><h2 id={headingId}>Markdown 成稿预览</h2><p className="digest-article-title">{artifact.bundle.workspace.userTitle || '未命名成稿'}</p><p className="digest-article-version">{devInfo ? versions.label : '固定成稿版本'}</p></header>{artifact.synthetic && <p className="digest-article-warning"><b>模拟任务产物</b>，仅用于验证，不计入真实消化成功。</p>}{artifact.candidate && <p className="digest-article-warning"><b>AI 新版本待查看</b>。本预览使用固定生成稿，当前人工正文和导图没有被替换。</p>}{!artifact.inLibrary && <p className="digest-article-note">当前未归入消化库，已经保存的成稿资料仍然保留。</p>}<p className="digest-article-note">音视频文件未包含在 Markdown 附件中。下方正文与大纲来自同一份固定成果，后续手工编辑不改写此成稿版本。</p><article className="digest-article-copy" aria-label="固定成稿正文">{artifact.bundle.draft.blocks.map(block => <ArticleBlock key={block.id} block={block} artifact={artifact} assetUrl={assetUrl} />)}</article><details className="digest-article-outline"><summary>对应导图大纲 · {Object.keys(artifact.bundle.map.nodes).length} 个节点</summary><ul><OutlineNode node={artifact.bundle.map.nodes[artifact.bundle.map.rootId]} artifact={artifact} assetUrl={assetUrl} /></ul></details><details className="digest-article-originals"><summary>已保存的来源资料与覆盖说明</summary>{artifact.bundle.sources.map(source => <section key={`${source.sourceId}@${source.sourceRevisionId}`}><p className="digest-article-note">{source.coverage.description || (source.coverage.complete ? '该来源已记录完整覆盖' : '该来源仅记录部分覆盖')}</p>{source.blocks.map(block => <ArticleBlock key={block.id} block={block} artifact={artifact} assetUrl={assetUrl} />)}{digestSafeLink(source.originalUrl) && <a href={source.originalUrl} target="_blank" rel="noopener noreferrer">来源原链接 <IconExternal size={12} /></a>}</section>)}{artifact.bundle.transcripts.length > 0 && <section><h3>保留的字幕／识别文字</h3>{artifact.bundle.transcripts.map(segment => <div key={`${segment.transcriptId}@${segment.revision}:${segment.segmentId}`}><p><ArticleRuns runs={segment.runs} /></p>{(!segment.timing || segment.timing.state === 'unknown') && <p className="digest-article-note">句子时间未知，仅保留文字定位，不提供精确播放。</p>}</div>)}</section>}</details><details className="digest-article-markdown"><summary>查看原 Markdown 文本</summary><pre>{artifact.markdownText}</pre></details></section>;
}
