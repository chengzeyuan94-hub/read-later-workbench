import { validateIsolationDirectory } from './isolation.js';
try { validateIsolationDirectory(process.env.RLW_E0_DIR); }
catch (error) { console.error('E0 refused:', (error as Error).message); process.exit(2); }
