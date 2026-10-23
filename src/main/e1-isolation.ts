import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isCanonicalPath } from './fs-paths.js';
export interface E1Paths {
    root: string;
    dataDir: string;
    userDataDir: string;
    assetsDir: string;
    exportsDir: string;
    evidenceDir: string;
}
function entry(value: string) { try {
    return lstatSync(value);
}
catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return undefined;
    throw error;
} }
function noAliases(value: string): void { let current = path.parse(value).root; for (const segment of value.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    const info = entry(current);
    if (info?.isSymbolicLink())
        throw new Error('E1 refuses symlink or aliased paths');
} if (entry(value) && !isCanonicalPath(value))
    throw new Error('E1 refuses path aliases'); }
/** No default. Validation happens before Electron userData or Store may be opened. */
export function resolveE1Paths(value: string | undefined, options: {
    mustExist?: boolean;
    projectRoot?: string;
} = {}): E1Paths {
    if (!value || !path.isAbsolute(value) || path.normalize(value) !== value || value.endsWith(path.sep))
        throw new Error('E1 requires an explicit normalized absolute RLW_E1_DIR');
    const project = options.projectRoot ?? process.cwd(), allowed = path.resolve(project, '.acceptance-data/editor-e1');
    if (!value.startsWith(allowed + path.sep) || value.slice(allowed.length + 1).includes(path.sep) || !/^[-a-zA-Z0-9_]+$/.test(path.basename(value)))
        throw new Error('E1 directory must be one fresh run under .acceptance-data/editor-e1');
    noAliases(value);
    const paths = { root: value, dataDir: path.join(value, 'data'), userDataDir: path.join(value, 'userData'), assetsDir: path.join(value, 'editor-assets'), exportsDir: path.join(value, 'exports'), evidenceDir: path.join(value, 'evidence') };
    for (const directory of Object.values(paths)) {
        noAliases(directory);
        if (options.mustExist && !entry(directory)?.isDirectory())
            throw new Error('E1 prepared directory missing');
    }
    const markerPath = path.join(value, 'e1-isolated.json');
    noAliases(markerPath);
    // Also reject a database/media/profile symlink planted below an otherwise valid run root.
    for (const directory of [path.join(paths.dataDir, 'workbench.sqlite'), path.join(paths.dataDir, 'media'), path.join(paths.userDataDir, 'profile')])
        noAliases(directory);
    if (options.mustExist) {
        if (!entry(markerPath)?.isFile())
            throw new Error('E1 prepared marker missing');
        const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
        if (marker.kind !== 'read-later-workbench-editor-e1' || marker.root !== value || marker.schema !== 1)
            throw new Error('E1 requires its prepared isolation marker');
    }
    return paths;
}
export function createE1Paths(value: string | undefined, options: {
    projectRoot?: string;
} = {}): E1Paths { const p = resolveE1Paths(value, options); if (entry(p.root))
    throw new Error('E1 preparation requires a new run directory; existing results are preserved'); for (const dir of Object.values(p))
    mkdirSync(dir, { recursive: true, mode: 0o700 }); return p; }
