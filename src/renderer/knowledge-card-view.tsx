import { AvatarImage } from './avatar';
import type { KnowledgeCardPayload } from '../shared/knowledge-card';
import { cardBarcode, viewpointLayout } from './knowledge-card';
import './knowledge-card.css';

/** The printable 1080×1440 poster. Always light paper, regardless of app theme. */
export function KnowledgeCardArt({ card, scale }: { card: KnowledgeCardPayload; scale?: number }) {
  const layout = viewpointLayout(card.viewpoint || '　');
  const shown = card.points.slice(0, 4);
  const more = Math.max(0, card.pointsTotal - shown.length);
  return (
    <div className="kc-stage" style={scale !== undefined ? { transform: `scale(${scale})` } : undefined}>
      <article className="kc-card">
        <header className="kc-head">
          <span className="kc-brand">L叔知识卡 · KNOWLEDGE CARD</span>
          <span className="kc-meta"><b>{card.number}</b>{card.date}</span>
        </header>
        {card.parent ? <p className="kc-parent">来自「{card.parent}」</p> : null}
        <section className="kc-body">
          <div className="kc-section-band" aria-hidden="true"><span>观点</span><span>VIEWPOINT</span></div>
          <p className={`kc-viewpoint kc-${layout.family}`} style={{ fontSize: layout.size }}>{layout.display}</p>
          <div className="kc-highlight" aria-hidden="true" />
          {shown.length > 0 && (
            <>
              <div className="kc-section-band kc-band-gap" aria-hidden="true"><span>要点</span><span>POINTS</span></div>
              <ul className="kc-points">
              {shown.map((point, index) => (
                <li key={index}>
                  <span className="kc-num">{String(index + 1).padStart(2, '0')}</span>
                  <i className="kc-bullet" aria-hidden="true" />
                  <span className="kc-point-text">{point}</span>
                </li>
              ))}
              {more > 0 && <li className="kc-more">等 {card.pointsTotal} 条</li>}
              </ul>
            </>
          )}
        </section>
        <section className="kc-source">
          {card.source.platform && <p><b>出处</b><span>{card.source.platform}</span></p>}
          {card.source.author && <p><b>作者</b><span>{card.source.author}</span></p>}
          {card.source.title && <p><b>原文</b><span>{card.source.title}</span></p>}
          <div className="kc-barcode" aria-hidden="true">
            {cardBarcode(card.number).map((width, index) => <i key={index} style={{ width: width * 3 }} />)}
            <small>{card.number}</small>
          </div>
        </section>
        <footer className="kc-foot">
          <AvatarImage />
          <div className="kc-foot-text"><b>L叔</b><p>收藏是起点，成果留给自己。</p></div>
          <span className="kc-foot-app">收藏阅读工作台</span>
        </footer>
      </article>
    </div>
  );
}

/** Card-only route for the hidden export window. Data arrives on window.__knowledgeCard. */
export function KnowledgeCardRoute() {
  const card = (window as unknown as { __knowledgeCard?: KnowledgeCardPayload }).__knowledgeCard;
  if (!card) return null;
  return <KnowledgeCardArt card={card} />;
}
