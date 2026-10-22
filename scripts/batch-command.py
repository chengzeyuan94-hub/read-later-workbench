#!/usr/bin/env python3
"""Send one finite acceptance command to the already-running isolated app.

No database writes, credentials, browser actions, or arbitrary evaluation.
"""
import argparse
import json
import os
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['snapshot', 'source-diagnostics', 'sync', 'processing', 'create', 'pause', 'resume', 'retry-digest', 'pause-downloads', 'pause-content-download', 'resume-downloads', 'retry-download', 'export-completed'])
parser.add_argument('--root', required=True)
parser.add_argument('--id', required=True)
parser.add_argument('--platform', choices=['xiaohongshu', 'bilibili', 'weibo', 'zhihu', 'twitter'])
parser.add_argument('--content', type=int)
parser.add_argument('--reason', choices=['此条未纳入自动下载'])
parser.add_argument('--contents', type=int, nargs='+')
parser.add_argument('--batch')
parser.add_argument('--allowed', choices=['true', 'false'])
parser.add_argument('--wait', type=float, default=10)
args = parser.parse_args()
root = Path(args.root).resolve()
if root.parent != Path.cwd() / '.acceptance-data/batch-sync' or not root.name.startswith('e42-'):
    parser.error('root must be this project’s prepared batch root')
live = root / 'evidence/live'
command = {'id': args.id, 'action': args.action}
for key, value in [('platform', args.platform), ('contentId', args.content), ('contentIds', args.contents), ('batchId', args.batch), ('reason', args.reason)]:
    if value is not None:
        command[key] = value
if args.allowed is not None:
    command['allowed'] = args.allowed == 'true'
if not args.id or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in args.id) or len(args.id) > 80:
    parser.error('invalid command id')
receipt = live / (args.id + '.result.json')
if receipt.exists() or (live / (args.id + '.request.json')).exists():
    parser.error('command id already used; inspect the existing receipt')
temporary = live / (args.id + '.pending-command')
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, 'w') as stream:
        json.dump(command, stream)
    slot_deadline = time.monotonic() + 55
    while True:
        try:
            os.link(temporary, live / 'command.json')
            break
        except FileExistsError:
            if time.monotonic() >= slot_deadline:
                raise RuntimeError('another finite command is pending; it was not overwritten')
            time.sleep(0.25)
finally:
    temporary.unlink(missing_ok=True)
deadline = time.monotonic() + min(max(args.wait, 0), 55)
while time.monotonic() < deadline and not receipt.exists():
    time.sleep(0.25)
print(receipt.read_text() if receipt.exists() else json.dumps({'pending': True, 'receipt': str(receipt)}))
