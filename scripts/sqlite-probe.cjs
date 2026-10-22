const path = require('node:path');
const Database = require('better-sqlite3');
const runtime = process.versions.electron ? 'electron' : 'node24';
function verify() {
  const db = new Database(':memory:', {nativeBinding:path.resolve('.runtime',`${runtime}.node`)});
  db.exec('CREATE TABLE probe (n INTEGER)');
  db.prepare('INSERT INTO probe VALUES (?)').run(24);
  if (db.prepare('SELECT n FROM probe').get().n !== 24) throw new Error('SQLite roundtrip failed');
  console.log(JSON.stringify({runtime,node:process.versions.node,electron:process.versions.electron,abi:process.versions.modules,sqlite:db.prepare('select sqlite_version() as version').get().version,ok:true}));
  db.close();
}
if (process.versions.electron) require('electron').app.whenReady().then(()=>{verify();require('electron').app.quit();});
else verify();
