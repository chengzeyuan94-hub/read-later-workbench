import { Schema, Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, splitBlock, chainCommands, newlineInCode, createParagraphNear, liftEmptyBlock, wrapIn } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo, closeHistory } from 'prosemirror-history';
import { isSafeLink, validateAssetRef, validateBlock, pointLength, type AssetRef, type DraftBlock, type TextRun } from './model.js';

export type Run=TextRun;
export type Block=DraftBlock;
const fresh = () => `block-${crypto.randomUUID()}`;
const identityAttrs={id:{default:null},assetRefs:{default:null}};
export const editorSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: identityAttrs, parseDOM: [{tag:'p'}], toDOM: node => ['p', {'data-block-id':node.attrs.id},0] },
    heading: { group:'block',content:'inline*',attrs:{...identityAttrs,level:{default:1}},defining:true,parseDOM:[1,2,3,4,5,6].map(level=>({tag:`h${level}`,attrs:{level}})),toDOM:node=>[`h${node.attrs.level}`,{'data-block-id':node.attrs.id},0] },
    bulletList:{group:'block',content:'listItem+',attrs:identityAttrs,parseDOM:[{tag:'ul'}],toDOM:node=>['ul',{'data-block-id':node.attrs.id},0]},
    orderedList:{group:'block',content:'listItem+',attrs:{...identityAttrs,start:{default:1}},parseDOM:[{tag:'ol',getAttrs:dom=>{const start=Number((dom as HTMLElement).getAttribute('start'));return{start:Number.isSafeInteger(start)&&start>=1?start:1};}}],toDOM:node=>['ol',{'data-block-id':node.attrs.id,start:node.attrs.start},0]},
    listItem:{content:'paragraph block*',attrs:identityAttrs,defining:true,parseDOM:[{tag:'li'}],toDOM:node=>['li',{'data-block-id':node.attrs.id},0]},
    blockquote:{group:'block',content:'block+',attrs:identityAttrs,defining:true,parseDOM:[{tag:'blockquote'}],toDOM:node=>['blockquote',{'data-block-id':node.attrs.id},0]},
    // No image parseDOM: only the application can insert an owned local asset.
    image:{group:'block',atom:true,draggable:false,attrs:identityAttrs,toDOM:node=>['span',{'data-block-id':node.attrs.id,'data-local-image':'true',contenteditable:'false'},'本地图片']},
    text: { group: 'inline' },
    hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
  },
  marks: {
    strong: { attrs: { enabled: { default: true } }, parseDOM: [{ tag: 'strong' }, { tag: 'b' }, {tag:'[data-e1-bold]'}, { tag: 'span[data-e0-strong]', getAttrs: dom => ({ enabled: (dom as HTMLElement).dataset.e0Strong !== 'false' }) }], toDOM: mark => mark.attrs.enabled ? ['strong', { 'data-e0-strong': 'true' }, 0] : ['span', { 'data-e0-strong': 'false', style: 'font-weight:400' }, 0] },
    em: { attrs: { enabled: { default: true } }, parseDOM: [{ tag: 'em' }, { tag: 'i' }, {tag:'[data-e1-italic]'}, { tag: 'span[data-e0-em]', getAttrs: dom => ({ enabled: (dom as HTMLElement).dataset.e0Em !== 'false' }) }], toDOM: mark => mark.attrs.enabled ? ['em', { 'data-e0-em': 'true' }, 0] : ['span', { 'data-e0-em': 'false', style: 'font-style:normal' }, 0] },
    code: { attrs: { enabled: { default: true } }, parseDOM: [{ tag: 'code' }, {tag:'[data-e1-code]'}, { tag: 'span[data-e0-code]', getAttrs: dom => ({ enabled: (dom as HTMLElement).dataset.e0Code !== 'false' }) }], toDOM: mark => mark.attrs.enabled ? ['code', { 'data-e0-code': 'true' }, 0] : ['span', { 'data-e0-code': 'false', style: 'font-family:inherit' }, 0] },
    link:{attrs:{href:{}},inclusive:false,parseDOM:[{tag:'a[href]',getAttrs:dom=>{const href=(dom as HTMLAnchorElement).getAttribute('href');return isSafeLink(href)?{href}:false;}}],toDOM:mark=>['a',{href:mark.attrs.href,rel:'noopener noreferrer'},0]},
  },
});
function inlineNodes(runs: Run[]) {
  return runs.flatMap(run => {
    const marks = [run.bold !== undefined ? editorSchema.marks.strong.create({ enabled: run.bold }) : null, run.italic !== undefined ? editorSchema.marks.em.create({ enabled: run.italic }) : null, run.code !== undefined ? editorSchema.marks.code.create({ enabled: run.code }) : null,run.href?editorSchema.marks.link.create({href:run.href}):null].filter(Boolean) as ReturnType<typeof editorSchema.marks.strong.create>[];
    return run.text.split('\n').flatMap((text, i) => [...(i ? [editorSchema.nodes.hard_break.create(null, null, marks)] : []), ...(text ? [editorSchema.text(text, marks)] : [])]);
  });
}
export function toPM(blocks: Block[]): PMNode {
  const node=(block:Block):PMNode=>{validateBlock(block);return editorSchema.nodes[block.type].create({id:block.id,level:block.level??1,start:block.start??1,assetRefs:block.assetRefs??null},block.children?block.children.map(node):block.type==='image'?null:Fragment.from(inlineNodes(block.runs)));};
  return editorSchema.nodes.doc.create(null,(blocks.length?blocks:[{id:fresh(),type:'paragraph' as const,runs:[]}]).map(node));
}
export function fromPM(doc: PMNode): Block[] {
  const block=(node:PMNode):Block=>{
    const runs:Run[]=[];if(node.isTextblock)node.forEach(child=>{const run:Run={text:child.type.name==='hard_break'?'\n':child.text||''};for(const [key,name]of [['bold','strong'],['italic','em'],['code','code']]as const){const mark=child.marks.find(m=>m.type.name===name);if(mark)run[key]=mark.attrs.enabled;}const link=child.marks.find(m=>m.type.name==='link');if(link)run.href=link.attrs.href;const previous=runs.at(-1);if(previous&&previous.bold===run.bold&&previous.italic===run.italic&&previous.code===run.code&&previous.href===run.href)previous.text+=run.text;else runs.push(run);});
    const children:Block[]=[];if(!node.isTextblock&&node.type.name!=='image')node.forEach(child=>children.push(block(child)));
    return{id:node.attrs.id,type:node.type.name as Block['type'],...(node.type.name==='heading'?{level:node.attrs.level}:{}),...(node.type.name==='orderedList'&&node.attrs.start!==1?{start:node.attrs.start}:{}),runs,...(node.attrs.assetRefs?{assetRefs:node.attrs.assetRefs}:{}),...(children.length?{children}:{})};
  };
  const result:Block[]=[];doc.forEach(node=>result.push(block(node)));return result;
}
/** Split/merge: first surviving leaf keeps its ID; inserted duplicate/right leaves receive new IDs. Undo restores exact identities. */
export const stableIds = new Plugin({appendTransaction(transactions,_old,state){if(!transactions.some(tr=>tr.docChanged))return null;const seen=new Set<string>(),tr=state.tr;state.doc.descendants((node,pos)=>{if(node.isText||node.type.name==='hard_break')return;let id=node.attrs.id as string|null;if(!id||seen.has(id)){id=fresh();tr.setNodeMarkup(pos,undefined,{...node.attrs,id});}seen.add(id);});return tr.docChanged?tr.setMeta('addToHistory',false):null;}});
/** Tri-state marks: absent inherits the node, false explicitly disables that style. */
export function toggleInlineMark(name: 'strong' | 'em' | 'code', inherited?: boolean): Command {
  return (state, dispatch) => {
    const mark = editorSchema.marks[name]; const { from, to, empty, $from } = state.selection;
    if (empty) { const existing = (state.storedMarks || $from.marks()).find(value => value.type === mark);const enabled = existing ? existing.attrs.enabled : inherited ?? (name === 'strong' && $from.parent.type.name === 'heading');dispatch?.(state.tr.removeStoredMark(mark).addStoredMark(mark.create({ enabled: !enabled }))); return true; }
    let allEnabled = true;state.doc.nodesBetween(from,to,(node,_pos,parent)=>{if(node.isInline){const existing=node.marks.find(value=>value.type===mark),base=inherited??(name==='strong'&&parent?.type.name==='heading');if(!(existing?existing.attrs.enabled:base))allEnabled=false;}});dispatch?.(state.tr.removeMark(from,to,mark).addMark(from,to,mark.create({enabled:!allEnabled})).scrollIntoView());return true;
  };
}
export function setTextBlock(type:'paragraph'|'heading',level:1|2|3=1):Command{return(state,dispatch)=>{const target=editorSchema.nodes[type],tr=state.tr;let eligible=false;state.doc.nodesBetween(state.selection.from,state.selection.to,(node,pos,parent,index)=>{if(!node.isTextblock||!['paragraph','heading'].includes(node.type.name)||!parent?.canReplaceWith(index,index+1,target))return;eligible=true;tr.setNodeMarkup(pos,target,{...node.attrs,...(type==='heading'?{level}:{})});});if(!eligible)return false;dispatch?.(tr.scrollIntoView());return true;};}
/** Wrap the selected blocks; a repeated call creates a nested semantic level. */
export function wrapBlock(kind:'bulletList'|'orderedList'|'blockquote'):Command {
  if(kind==='blockquote')return wrapIn(editorSchema.nodes.blockquote);
  return(state,dispatch)=>{
    const range=state.selection.$from.blockRange(state.selection.$to);if(!range)return false;
    if(range.parent.type.name==='listItem'){
      for(let depth=state.selection.$from.depth;depth>0;depth--){const list=state.selection.$from.node(depth);if(!['bulletList','orderedList'].includes(list.type.name))continue;if(list.type.name===kind)return false;dispatch?.(state.tr.setNodeMarkup(state.selection.$from.before(depth),editorSchema.nodes[kind],{...list.attrs,start:1}));return true;}
    }
    const content:PMNode[]=[];for(let i=range.startIndex;i<range.endIndex;i++){const n=range.parent.child(i),leaf=n.type.name==='paragraph'?n:editorSchema.nodes.paragraph.create({id:n.isTextblock?(n.attrs.id??fresh()):fresh()},n.isTextblock?n.content:undefined);content.push(editorSchema.nodes.listItem.create({id:fresh()},[leaf,...(!n.isTextblock?[n]:[])]));}if(!content.length)return false;
    const list=editorSchema.nodes[kind].create({id:fresh()},content),tr=closeHistory(state.tr).replaceWith(range.start,range.end,list);restoreLeafSelection(tr,state);dispatch?.(tr.scrollIntoView());return true;
  };
}
function restoreLeafSelection(tr:import('prosemirror-state').Transaction,state:EditorState){const a=state.selection.$from,b=state.selection.$to;if(!a.parent.isTextblock||!b.parent.isTextblock)return;let from:number|undefined,to:number|undefined;tr.doc.descendants((node,pos)=>{if(node.isTextblock&&node.attrs.id===a.parent.attrs.id)from=pos+1+Math.min(a.parentOffset,node.content.size);if(node.isTextblock&&node.attrs.id===b.parent.attrs.id)to=pos+1+Math.min(b.parentOffset,node.content.size);});if(from!==undefined&&to!==undefined)tr.setSelection(TextSelection.create(tr.doc,from,to));}
/** A list indent moves the complete selected item under its preceding sibling; outdent promotes it after its parent item. */
export function changeListIndent(direction:'indent'|'outdent'):Command{return(state,dispatch)=>{
  let itemId:string|undefined;for(let depth=state.selection.$from.depth;depth>0;depth--)if(state.selection.$from.node(depth).type.name==='listItem'){if(state.selection.$to.pos>state.selection.$from.end(depth))return false;itemId=state.selection.$from.node(depth).attrs.id;break;}if(!itemId)return false;
  const blocks=fromPM(state.doc);type Place={block:Block;parent:Block|null;siblings:Block[];index:number};const places:Place[]=[];const walk=(items:Block[],parent:Block|null)=>items.forEach((block,index)=>{places.push({block,parent,siblings:items,index});if(block.children)walk(block.children,block);});walk(blocks,null);const item=places.find(p=>p.block.id===itemId);if(!item||!item.parent||!['bulletList','orderedList'].includes(item.parent.type))return false;const list=places.find(p=>p.block===item.parent)!;
  if(direction==='indent'){if(item.index===0)return false;const previous=item.siblings[item.index-1];let sub=previous.children!.at(-1);if(!sub||sub.type!==list.block.type){sub={id:fresh(),type:list.block.type,runs:[],children:[]};previous.children!.push(sub);}item.siblings.splice(item.index,1);sub.children!.push(item.block);}
  else{if(list.parent?.type!=='listItem')return false;const owner=places.find(p=>p.block===list.parent)!;if(!owner.parent||!['bulletList','orderedList'].includes(owner.parent.type))return false;item.siblings.splice(item.index,1);owner.siblings.splice(owner.index+1,0,item.block);if(!item.siblings.length)list.siblings.splice(list.siblings.indexOf(list.block),1);}
  const tr=closeHistory(state.tr).replaceWith(0,state.doc.content.size,toPM(blocks).content);restoreLeafSelection(tr,state);dispatch?.(tr.scrollIntoView());return true;
};}
export function setSafeLink(href:string|null):Command{return(state,dispatch)=>{if(href!==null&&!isSafeLink(href))return false;const {from,to,empty}=state.selection;if(empty)return false;const tr=state.tr.removeMark(from,to,editorSchema.marks.link);if(href)tr.addMark(from,to,editorSchema.marks.link.create({href}));dispatch?.(tr);return true;};}
export function insertImage(ref:AssetRef):Command {validateAssetRef(ref);return(state,dispatch)=>{dispatch?.(state.tr.replaceSelectionWith(editorSchema.nodes.image.create({id:fresh(),assetRefs:[{...ref}]})).scrollIntoView());return true;};}
/** Before PM inserts HTML into its clipboard DOM, remove resource-bearing and active HTML. */
export function normalizePastedHTML(html:string):string {
  return html.replace(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,(_all,a,b,c)=>{const css=String(a??b??c),weight=css.match(/(?:^|;)\s*font-weight\s*:\s*([^;]+)/i)?.[1].trim(),italic=/(?:^|;)\s*font-style\s*:\s*(?:italic|oblique)/i.test(css),code=/(?:^|;)\s*font-family\s*:[^;]*monospace/i.test(css);return (weight==='bold'||Number(weight)>=600?' data-e1-bold="true"':'')+(italic?' data-e1-italic="true"':'')+(code?' data-e1-code="true"':'');}).replace(/<(script|style|iframe|object|embed|svg|math|video|audio|picture)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'[不支持的嵌入内容未导入]').replace(/<img\b[^>]*>/gi,'[外部图片未导入]').replace(/<\/?(?:script|style|iframe|object|embed|svg|math|video|audio|picture|image|canvas|applet|portal|fencedframe)\b[^>]*>/gi,'[不支持的嵌入内容未导入]').replace(/<(?:link|meta|base|source|embed|input)\b[^>]*>/gi,'').replace(/\s(?:src|srcset|srcdoc|poster|background|xlink:href|codebase|data|style|on[a-z]+|data-block-id|data-local-image)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'');
}
/** Even clipboard HTML emitted by this app is external input: never import its block/resource identity. */
export function freshPastedSlice(slice:Slice):Slice {const map=(fragment:Fragment):Fragment=>{const result:PMNode[]=[];fragment.forEach(node=>{if(node.type.name==='image')return;if(node.isText){result.push(node);return;}const attrs={...node.attrs};if(Object.hasOwn(attrs,'id'))attrs.id=fresh();if(Object.hasOwn(attrs,'assetRefs'))attrs.assetRefs=null;const content=map(node.content);result.push(node.type.create(attrs,content,node.marks));});return Fragment.from(result);};return new Slice(map(slice.content),slice.openStart,slice.openEnd);}
/** Node-title paste is inline rich text with explicit breaks, never nested containers or hidden images. */
export function titlePastedSlice(slice:Slice):Slice {const inline:PMNode[]=[];slice.content.descendants(node=>{if(node.isTextblock){if(inline.length)inline.push(editorSchema.nodes.hard_break.create());node.forEach(child=>{if(child.isInline)inline.push(child);});return false;}if(node.isInline)inline.push(node);});return new Slice(Fragment.from(inline),0,0);}
export interface EditorOptions { title?: boolean; inheritedBold?: boolean; inheritedItalic?: boolean; assetUrl?(ref:AssetRef):string; onChange(blocks: Block[], view: EditorView): void; onCommit?(): void; onCancel?(): void; onBlur?(): void; onComposition?(composing: boolean): void; onPasteWarning?(message:string):void; onUndo?():void; onRedo?():void }
export function mountEditor(element: HTMLElement, blocks: Block[], options: EditorOptions): EditorView {
  let composing=false;
  const inputKeys=new Plugin({props:{handleDOMEvents:{compositionstart:()=>{composing=true;options.onComposition?.(true);return false;},compositionend:()=>{composing=false;options.onComposition?.(false);return false;},keydown:(view,event)=>{
    if(event.isComposing||composing||event.keyCode===229||view.composing){event.stopPropagation();return true;}
    if(options.title&&['Enter','Tab','Escape'].includes(event.key)){event.stopPropagation();if(event.key==='Enter'&&event.shiftKey){event.preventDefault();view.dispatch(view.state.tr.replaceSelectionWith(editorSchema.nodes.hard_break.create()).scrollIntoView());return true;}event.preventDefault();if(event.key==='Escape')options.onCancel?.();else options.onCommit?.();return true;}
    if(event.key==='Tab')event.stopPropagation();return false;
  },blur:()=>{options.onBlur?.();return false;}}}});
  const view=new EditorView(element,{
    state:EditorState.create({schema:editorSchema,doc:toPM(blocks),plugins:[inputKeys,stableIds,history(),keymap({'Mod-b':toggleInlineMark('strong',options.inheritedBold),'Mod-i':toggleInlineMark('em',options.inheritedItalic),'Mod-z':options.onUndo?()=>{options.onUndo!();return true;}:undo,'Shift-Mod-z':options.onRedo?()=>{options.onRedo!();return true;}:redo,'Mod-y':options.onRedo?()=>{options.onRedo!();return true;}:redo,'Enter':chainCommands(newlineInCode,createParagraphNear,liftEmptyBlock,splitBlock),'Shift-Enter':(state,dispatch)=>{dispatch?.(state.tr.replaceSelectionWith(editorSchema.nodes.hard_break.create()).scrollIntoView());return true;}}),keymap(baseKeymap)]}),
    dispatchTransaction(transaction){const result=view.state.applyTransaction(transaction);view.updateState(result.state);if(result.transactions.some(tr=>tr.docChanged)&&!transaction.getMeta('editor-content-replacement'))options.onChange(fromPM(view.state.doc),view);},
    transformPastedHTML(html){const normalized=normalizePastedHTML(html);if(/<(?:img|iframe|object|script|video|audio|svg)\b/i.test(html))options.onPasteWarning?.('外部图片与嵌入内容未导入；文字保留，可从本地图片选择器加入图片。');return normalized;},transformPasted:slice=>options.title?titlePastedSlice(slice):freshPastedSlice(slice),
    handleClick(_view,_pos,event){if((event.target as Element)?.closest('a')){event.preventDefault();return true;}return false;},
    nodeViews:{image(node){const dom=document.createElement('figure');dom.dataset.blockId=node.attrs.id;dom.contentEditable='false';const ref=node.attrs.assetRefs?.[0] as AssetRef|undefined;if(ref&&options.assetUrl){const image=document.createElement('img');image.src=options.assetUrl(ref);image.alt='本地图片';image.style.maxWidth='100%';image.addEventListener('error',()=>{image.alt='本地图片缺失或损坏';dom.dataset.assetError='true';});dom.append(image);}else dom.textContent='本地图片（未提供读取地址）';return{dom};}},
    attributes:{'aria-label':options.title?'节点标题编辑':'我的整理稿',role:'textbox','aria-multiline':'true',spellcheck:'false'},
  });return view;
}
/** Single text leaf only. Offsets are Unicode code points, including emoji, not PM UTF-16. */
export function utf16OffsetToPoint(text:string,offset:number):number {if(!Number.isSafeInteger(offset)||offset<0||offset>text.length||(offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset])))throw new Error('selection splits a Unicode scalar');return pointLength(text.slice(0,offset));}
export function pointOffsetToUTF16(text:string,offset:number):number {if(!Number.isSafeInteger(offset)||offset<0||offset>pointLength(text))throw new Error('invalid code-point offset');return Array.from(text).slice(0,offset).join('').length;}
export function selectedBlockRange(view: EditorView): { blockId: string; start: number; end: number; excerpt: string } | null {
  const {from,to,$from,$to}=view.state.selection;if(from===to||!$from.parent.isTextblock||$from.parent!==$to.parent)return null;const text=$from.parent.textBetween(0,$from.parent.content.size,'\n','\n');return{blockId:$from.parent.attrs.id,start:utf16OffsetToPoint(text,$from.parentOffset),end:utf16OffsetToPoint(text,$to.parentOffset),excerpt:view.state.doc.textBetween(from,to,'\n','\n')};
}
/** Compatibility offsets remain UTF-16 for existing E0 probes. Use setPointSelection for business references. */
export function setSelection(view:EditorView,blockId:string,start:number,end=start){let found=false;view.state.doc.descendants((node,pos)=>{if(node.attrs.id===blockId&&node.isTextblock){view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,pos+1+start,pos+1+end)));found=true;return false;}return !found;});if(!found)throw new Error(`Block not found: ${blockId}`);view.focus();}
export function setPointSelection(view:EditorView,blockId:string,start:number,end=start){let text:string|undefined;view.state.doc.descendants(node=>{if(node.attrs.id===blockId&&node.isTextblock)text=node.textBetween(0,node.content.size,'\n','\n');});if(text===undefined||start<0||end<start||end>pointLength(text))throw new Error('invalid Unicode selection');setSelection(view,blockId,pointOffsetToUTF16(text,start),pointOffsetToUTF16(text,end));}
export function findText(view:EditorView,needle:string,next=true):boolean{if(!needle)return false;const hits:{from:number;to:number}[]=[];view.state.doc.descendants((node,pos)=>{if(!node.isTextblock)return;const text=node.textBetween(0,node.content.size,'\n','\n');let at=0;while((at=text.indexOf(needle,at))>=0){hits.push({from:pos+1+at,to:pos+1+at+needle.length});at+=Math.max(1,needle.length);}});if(!hits.length)return false;const hit=(next?hits.find(hit=>hit.from>view.state.selection.from):[...hits].reverse().find(hit=>hit.to<view.state.selection.to))??(next?hits[0]:hits.at(-1)!);view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,hit.from,hit.to)).scrollIntoView());view.focus();return true;}
export function replaceEditorBlocks(view:EditorView,blocks:Block[],options:{preserveSelection?:boolean}={}){const doc=toPM(blocks);if(doc.eq(view.state.doc))return;const from=view.state.selection.from,to=view.state.selection.to,tr=view.state.tr.replaceWith(0,view.state.doc.content.size,doc.content).setMeta('addToHistory',false).setMeta('editor-content-replacement',true);if(options.preserveSelection)tr.setSelection(TextSelection.create(tr.doc,Math.min(from,tr.doc.content.size-1),Math.min(to,tr.doc.content.size-1)));view.dispatch(tr);}
export function endInputHistory(view: EditorView) { view.dispatch(closeHistory(view.state.tr)); }
