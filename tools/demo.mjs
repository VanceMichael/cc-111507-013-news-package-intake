import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
const dataDir = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const service = await createService({ dataDir });
try {
  const source = await (await fetch(`${service.baseUrl}/v1/source`)).json();
  console.log('来源资料', JSON.stringify(source, null, 2));
  const raw = await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'raw' }) });
  console.log('原始收件', JSON.stringify(await raw.json(), null, 2));
  const response = await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'structured' }) });
  const result = await response.json();
  console.log('结构化收件', JSON.stringify({
    id: result.id, state: result.state, editable: result.coverage.editable,
    package: result.coverage.package, expectedItems: result.coverage.expectedItems,
    availableItems: result.coverage.availableItems, missingItems: result.coverage.missingItems,
    records: result.records.map(record => ({ id: record.id, available: record.available,
      itemVersion: record.itemVersion, roles: record.usages.map(usage => usage.roles.map(role => role.qcode).join('+')),
      groups: record.usages.map(usage => usage.groupPath.join('/')) })),
    issues: result.issues,
  }, null, 2));
  console.log('收件目录', JSON.stringify(await (await fetch(`${service.baseUrl}/v1/receipts`)).json(), null, 2));
} finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
