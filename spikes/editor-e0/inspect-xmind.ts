/** Read-only E0 acceptance inspector, deliberately not a product importer. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';

type JSONRecord = Record<string, unknown>;
export interface InspectedTopic {
  id: string; parentId: string | null; children: string[]; title: string;
  notes: string; href: string | null; image: string | null;
  attributedTitle: JSONRecord[]; style: JSONRecord | null;
}
export interface XmindInspection {
  bytes: number; sha256: string;
  entries: { name: string; bytes: number; sha256: string }[];
  sheets: { id: string; title: string; rootId: string; nodes: InspectedTopic[] }[];
  resources: { path: string; bytes: number; sha256: string; referencedBy: string[] }[];
  metadata: JSONRecord;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function record(value: unknown, label: string): JSONRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`);
  return value as JSONRecord;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}: expected string`);
  return value;
}
function safeEntry(name: string): void {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some(part => part === '.' || part === '..')) throw new Error('unsafe archive entry');
}
export function inspectXmindBytes(bytes: Uint8Array): XmindInspection {
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('E0 archive exceeds 32 MiB');
  let advertisedTotal = 0;
  const names = new Set<string>();
  const entries = unzipSync(bytes, { filter: file => {
    safeEntry(file.name);
    if (names.has(file.name)) throw new Error('duplicate archive entry');
    names.add(file.name);
    advertisedTotal += file.originalSize;
    if (names.size > 256 || file.originalSize > 16 * 1024 * 1024 || advertisedTotal > 64 * 1024 * 1024) throw new Error('E0 archive expansion limit');
    return true;
  } });
  const json = (name: string): unknown => {
    if (!entries[name]) throw new Error(`missing ${name}`);
    return JSON.parse(strFromU8(entries[name]!));
  };
  const content = json('content.json');
  if (!Array.isArray(content) || content.length < 1 || content.length > 10) throw new Error('invalid sheet array');
  const metadata = record(json('metadata.json'), 'metadata');
  const manifest = record(record(json('manifest.json'), 'manifest')['file-entries'], 'manifest entries');
  for (const name of Object.keys(manifest)) {
    safeEntry(name);
    if (!entries[name] && !name.endsWith('/')) throw new Error(`manifest points to missing entry ${name}`);
  }
  const seenIds = new Set<string>();
  const resources = new Map<string, string[]>();
  const sheets = content.map((rawSheet: unknown) => {
    const sheet = record(rawSheet, 'sheet');
    const id = text(sheet.id, 'sheet.id');
    if (seenIds.has(id)) throw new Error('duplicate sheet/topic id');
    seenIds.add(id);
    const nodes: InspectedTopic[] = [];
    const walk = (raw: unknown, parentId: string | null, depth: number): string => {
      if (depth > 50 || nodes.length >= 10000) throw new Error('E0 topic depth/count limit');
      const topic = record(raw, 'topic');
      const tid = text(topic.id, 'topic.id');
      if (!tid || seenIds.has(tid)) throw new Error('duplicate/missing topic id');
      seenIds.add(tid);
      const children = topic.children === undefined ? {} : record(topic.children, 'children');
      const attached = children.attached ?? [];
      if (!Array.isArray(attached)) throw new Error('invalid attached children');
      const noteObj = topic.notes === undefined ? {} : record(topic.notes, 'notes');
      const plain = noteObj.plain === undefined ? {} : record(noteObj.plain, 'plain notes');
      const image = topic.image === undefined ? null : text(record(topic.image, 'image').src, 'image.src');
      if (image) {
        if (!image.startsWith('xap:resources/')) throw new Error('E0 inspector only accepts embedded image resources');
        const resource = image.slice(4);
        safeEntry(resource);
        if (!entries[resource] || !(resource in manifest)) throw new Error(`missing embedded resource ${resource}`);
        resources.set(resource, [...(resources.get(resource) ?? []), tid]);
      }
      const attributedTitle = topic.attributedTitle === undefined ? [] : topic.attributedTitle;
      if (!Array.isArray(attributedTitle)) throw new Error('invalid attributedTitle');
      const inspected: InspectedTopic = {
        id: tid, parentId, children: [], title: text(topic.title ?? '', 'topic.title'),
        notes: text(plain.content ?? '', 'notes.content'),
        href: topic.href === undefined ? null : text(topic.href, 'href'), image,
        attributedTitle: attributedTitle.map(run => record(run, 'attributed run')),
        style: topic.style === undefined ? null : record(topic.style, 'style'),
      };
      nodes.push(inspected);
      inspected.children = attached.map(child => walk(child, tid, depth + 1));
      return tid;
    };
    const rootId = walk(sheet.rootTopic, null, 0);
    return { id, title: text(sheet.title ?? '', 'sheet.title'), rootId, nodes };
  });
  return {
    bytes: bytes.byteLength, sha256: hash(bytes), metadata, sheets,
    entries: Object.entries(entries).filter(([name]) => !name.endsWith('/')).map(([name, value]) => ({ name, bytes: value.byteLength, sha256: hash(value) })),
    resources: [...resources].map(([path, referencedBy]) => ({ path, bytes: entries[path]!.byteLength, sha256: hash(entries[path]!), referencedBy })),
  };
}
export async function inspectXmindFile(path: string): Promise<XmindInspection> {
  return inspectXmindBytes(await readFile(path));
}
