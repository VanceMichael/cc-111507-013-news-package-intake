import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
import { parsePackage, parseNewsItem, expandRelationships, expandQcode } from '../src/newsml.mjs';

async function structuredIntake(scenario, dataDir) {
  const service = await createService({ dataDir, scenario });
  try {
    const response = await fetch(`${service.baseUrl}/v1/intakes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'structured' }),
    });
    assert.equal(response.status, 201);
    return { receipt: await response.json(), service };
  } catch (error) {
    await service.close();
    throw error;
  }
}

async function withService(scenario, run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'newsml-test-'));
  const { receipt, service } = await structuredIntake(scenario, dataDir);
  try {
    await run({ receipt, service, dataDir });
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('结构化收件：包内关系、排序、备选组与版本区分', async () => {
  await withService('standard', async ({ receipt, service }) => {
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.coverage.structured, true);
    assert.equal(receipt.coverage.usable, true);
    assert.equal(receipt.records.length, 3);

    const [main, photo, photo2] = receipt.records;
    assert.equal(main.residref, 'urn:item:text');
    assert.equal(main.role, 'urn:local:roles:main');
    assert.equal(main.roleQcode, 'role:main');
    assert.equal(main.roleScheme, 'urn:local:roles:');
    assert.deepEqual(main.group.path, ['root']);
    assert.equal(main.alternatives, null);

    // 排序忠实保留：包内声明顺序即记录顺序
    assert.deepEqual(receipt.records.map((record) => record.order.overall), [0, 1, 2]);
    assert.equal(photo.order.inGroup, 0);
    assert.equal(photo2.order.inGroup, 1);

    // 备选素材：两者同属备选组，互不替代
    assert.equal(photo.alternatives.group, 'photos');
    assert.deepEqual(photo.alternatives.members, ['urn:item:photo', 'urn:item:photo2']);
    assert.deepEqual(photo2.alternatives.members, ['urn:item:photo', 'urn:item:photo2']);
    assert.equal(photo.role, 'urn:local:roles:illustration');

    // 包的版本、包要求的版本、内容项实际版本分别保存
    assert.equal(main.package.version, '2');
    assert.equal(main.version, '3');
    assert.equal(main.item.version, '3');
    assert.equal(main.item.guid, 'urn:item:text');
    assert.equal(photo.item, null);
    assert.equal(photo.state, 'received');

    // 外部概念解释范围只来自包文档目录
    assert.deepEqual(receipt.evidence.catalog, { role: 'urn:local:roles:' });
    assert.equal(receipt.evidence.package.version, '2');
    assert.equal(receipt.evidence.items.length, 3);

    // 稳定身份不依赖数组下标，且持久化后一致
    assert.ok(main.id.includes('urn:item:text'));
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.deepEqual(saved.records, receipt.records);
    assert.deepEqual(saved.coverage, receipt.coverage);
  });
});

test('结构化收件：备选素材缺失时不替代原稿并保留缺口', async () => {
  await withService('missing-alternative', async ({ receipt }) => {
    assert.equal(receipt.state, 'partial');
    assert.equal(receipt.coverage.usable, false);
    assert.equal(receipt.records.length, 3);

    const missing = receipt.records.find((record) => record.residref === 'urn:item:photo2');
    assert.equal(missing.state, 'missing');
    assert.equal(missing.blob, null);

    // 另一份备选稿仍是它自己，不被当成缺失的原稿
    const original = receipt.records.find((record) => record.residref === 'urn:item:photo');
    assert.equal(original.state, 'received');
    assert.equal(original.item, null);
    assert.notEqual(original.id, missing.id);
    assert.deepEqual(original.alternatives.members, ['urn:item:photo', 'urn:item:photo2']);

    assert.deepEqual(receipt.coverage.gaps.map((gap) => gap.residref), ['urn:item:photo2']);
    assert.ok(receipt.issues.some((issue) => issue.code === 'fetch-failed' && issue.record === missing.id));
    assert.ok(receipt.coverage.unusableReasons.some((reason) => reason.includes('urn:item:photo2')));
  });
});

test('结构化收件：撤回状态忠实保留，文件齐全不等于可供编辑', async () => {
  await withService('withdrawn', async ({ receipt }) => {
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.coverage.pubStatus, 'stat:canceled');
    assert.equal(receipt.coverage.usable, false);
    assert.ok(receipt.coverage.unusableReasons.some((reason) => reason.includes('stat:canceled')));
    assert.equal(receipt.records.every((record) => record.state === 'received'), true);
  });
});

test('结构化收件：groupRef 环路记录为问题而不是无限展开', async () => {
  await withService('cycle', async ({ receipt }) => {
    assert.equal(receipt.state, 'partial');
    assert.ok(receipt.issues.some((issue) => issue.code === 'group-cycle' && issue.severity === 'error'));
    assert.ok(receipt.issues.some((issue) => issue.code === 'unreachable-group' && issue.group === 'photos'));
    assert.equal(receipt.records.length, 1);
    assert.equal(receipt.records[0].residref, 'urn:item:text');
    assert.equal(receipt.records[0].state, 'received');
  });
});

test('结构化收件：契约之外的来源链接不继续遍历', async () => {
  await withService('outside-contract', async ({ receipt, service }) => {
    assert.equal(receipt.state, 'partial');
    const blocked = receipt.records.filter((record) => record.state === 'blocked');
    assert.deepEqual(blocked.map((record) => record.residref).sort(), ['urn:item:remote', 'urn:item:secret']);
    assert.ok(receipt.issues.filter((issue) => issue.code === 'outside-contract').length === 2);
    const story = receipt.records.find((record) => record.residref === 'urn:item:text');
    assert.equal(story.state, 'received');
    // 未向来源请求清单外资源，也绝不请求包内的绝对地址
    const requested = service.gateway.trace.map((entry) => entry.path);
    assert.ok(!requested.some((path) => path.includes('secret.xml')));
    assert.ok(requested.every((path) => path.startsWith('/files/') || path === '/manifest'));
  });
});

test('结构化收件：同一资源多处使用时角色各自成记录', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'newsml-test-'));
  const service = await createService({ dataDir, scenario: 'standard' });
  try {
    const response = await fetch(`${service.baseUrl}/v1/intakes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'structured' }),
    });
    const receipt = await response.json();
    const ids = receipt.records.map((record) => record.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const record of receipt.records) {
      assert.ok(record.id.includes(record.residref));
      assert.ok(record.id.includes(record.roleQcode));
    }
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化收件：新实例打开相同目录仍可查询既有记录', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'newsml-test-'));
  const first = await createService({ dataDir, scenario: 'standard' });
  let receipt;
  try {
    const response = await fetch(`${first.baseUrl}/v1/intakes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'structured' }),
    });
    receipt = await response.json();
  } finally {
    await first.close();
  }
  const second = await createService({ dataDir, scenario: 'standard' });
  try {
    const saved = await (await fetch(`${second.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.deepEqual(saved.records, receipt.records);
    assert.deepEqual(saved.coverage, receipt.coverage);
    assert.deepEqual(saved.evidence, receipt.evidence);
  } finally {
    await second.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('包解析：目录作用域不跨内容项继承', async () => {
  const packageBytes = await readFile(new URL('../fixtures/package.xml', import.meta.url));
  const storyBytes = await readFile(new URL('../fixtures/story.xml', import.meta.url));
  const model = parsePackage(packageBytes);
  assert.equal(model.ok, true);
  assert.deepEqual(expandQcode('role:main', model.catalog).uri, 'urn:local:roles:main');
  const item = parseNewsItem(storyBytes);
  assert.equal(item.ok, true);
  // 内容项没有自己的 catalog 时，包的别名不可用于解释内容项内的概念
  assert.equal(expandQcode('role:main', {}).uri, null);
  assert.equal(expandQcode('stat:usable', model.catalog).uri, null);
});

test('包解析：多角色与未声明扩展保留原始限定名', () => {
  const xml = `<packageItem xmlns="http://iptc.org/std/nar/2006-10-01/" guid="urn:pkg:t" version="1"><catalog><scheme alias="role" uri="urn:local:roles:"/></catalog><itemMeta><pubStatus qcode="stat:usable"/></itemMeta><groupSet root="g"><group id="g" mode="pgrmod:bag"><itemRef residref="urn:item:x" version="2"><role qcode="role:main"/><role qcode="other:backup"/><href>story.xml</href></itemRef></group></groupSet></packageItem>`;
  const model = parsePackage(Buffer.from(xml));
  assert.equal(model.ok, true);
  const { relations } = expandRelationships(model);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].member.roles.length, 2);
  assert.equal(expandQcode('other:backup', model.catalog).uri, null);
});

test('包解析：非 packageItem 与坏 XML 不可解释', () => {
  assert.equal(parsePackage(Buffer.from('<newsItem/>')).ok, false);
  assert.equal(parsePackage(Buffer.from('not xml at all')).ok, false);
  assert.equal(parseNewsItem(Buffer.from('<packageItem/>')).ok, false);
});
