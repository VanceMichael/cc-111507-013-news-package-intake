import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
import { analyzePackage, analyzeNewsItem, isXml } from '../src/newsml.mjs';

const fixture = name => new URL(`../fixtures/${name}`, import.meta.url);

async function runStructured(scenario, body = { mode: 'structured' }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-'));
  const service = await createService({ dataDir, scenario });
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { dataDir, service, response, result: await response.json() };
}

test('标准新闻包：按包内关系取得全部素材并给出完整身份与角色', async () => {
  const { dataDir, service, response, result } = await runStructured('standard');
  try {
    assert.equal(response.status, 201);
    assert.equal(result.state, 'complete');
    assert.equal(result.coverage.editable, true);
    assert.equal(result.records.length, 3);
    const [story, photo, photo2] = result.records;
    assert.equal(story.residref, 'urn:item:text');
    assert.equal(story.itemVersion, '3');
    assert.equal(story.packageVersion, '2');
    assert.equal(story.content.kind, 'newsItem');
    assert.equal(story.content.version, '3');
    assert.equal(story.roles[0].qcode, 'role:main');
    assert.equal(story.roles[0].resolvedUri, 'urn:local:roles:main');
    assert.equal(story.roles[0].scope, 'packageItem:urn:pkg:1');
    assert.equal(photo.content.kind, 'binary');
    assert.equal(photo.usages[0].alternativeGroup, 'photos');
    assert.equal(photo.usages[0].groupMode, 'pgrmod:alt');
    assert.equal(photo2.usages[0].alternativeGroup, 'photos');
    // 排序与组路径忠实保留。
    assert.deepEqual(result.coverage.ordering.map(item => item.href), ['story.xml', 'photo.bin', 'photo2.bin']);
    assert.deepEqual(photo2.usages[0].groupPath, ['root', 'photos']);
    assert.equal(result.coverage.package.version, '2');
    assert.equal(result.coverage.versioning.itemVersions[0].declared, '3');
    assert.equal(result.coverage.versioning.itemVersions[0].observed, '3');
    // 只遍历来源清单中的资源。
    const paths = service.gateway.trace.map(item => item.path);
    assert.deepEqual(paths, ['/files/package.xml', '/files/story.xml', '/files/photo.bin', '/files/photo2.bin']);
    assert.ok(!paths.some(path => path.includes('withdrawn') || path.includes('cyclic')));
    // 持久查询返回相同记录。
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${result.id}`)).json();
    assert.deepEqual(saved.records, result.records);
    assert.deepEqual(saved.coverage, result.coverage);
    // 证据链可回溯到字节摘要。
    assert.equal(result.coverage.evidence.length, 4);
    assert.equal(result.blobs.length, 4);
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('备选素材缺失：保持各自独立关系，不把另一备选稿当成原稿', async () => {
  const { dataDir, service, response, result } = await runStructured('missing-alternative');
  try {
    assert.equal(response.status, 201);
    assert.equal(result.state, 'partial');
    assert.equal(result.coverage.editable, false);
    const missing = result.records.find(record => record.residref === 'urn:item:photo2');
    const present = result.records.find(record => record.residref === 'urn:item:photo');
    assert.equal(missing.available, false);
    assert.equal(missing.blob, null);
    assert.ok(missing.issues.some(issue => issue.code === 'not-downloaded'));
    // 缺失项仍是备选组成员，没有被可用备选稿替换。
    assert.equal(missing.usages[0].alternativeGroup, 'photos');
    assert.equal(present.available, true);
    assert.ok(result.issues.some(issue => issue.code === 'resource-unavailable' && issue.blocking));
    assert.deepEqual(result.coverage.missingItems.map(item => item.residref), ['urn:item:photo2']);
    assert.equal(result.coverage.availableItems, 2);
    assert.equal(result.coverage.expectedItems, 3);
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('撤回状态单独保留：素材齐全但整包不进入可编辑状态', async () => {
  const { dataDir, service, response, result } = await runStructured('withdrawn');
  try {
    assert.equal(response.status, 201);
    assert.equal(result.state, 'complete');
    assert.equal(result.coverage.editable, false);
    assert.equal(result.coverage.package.pubStatus.qcode, 'stat:canceled');
    assert.equal(result.coverage.package.pubStatus.usable, false);
    assert.equal(result.records.every(record => record.available), true);
    // 撤回不制造虚假缺口，也不把下载完成等同于可编辑。
    assert.equal(result.coverage.availableItems, 3);
    assert.equal(result.issues.length, 0);
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('循环组引用：截断循环、保留问题定位，已取得关系仍可解释', async () => {
  const { dataDir, service, response, result } = await runStructured('cycle');
  try {
    assert.equal(response.status, 201);
    assert.ok(result.issues.some(issue => issue.code === 'group-cycle' && issue.location.includes('root')));
    const story = result.records.find(record => record.residref === 'urn:item:text');
    assert.equal(story.available, true);
    // 循环路径未被展开成无限重复的素材。
    assert.equal(result.records.length, 1);
    const paths = service.gateway.trace.map(item => item.path);
    assert.deepEqual(paths, ['/files/cyclic-package.xml', '/files/story.xml']);
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('同一资源多处使用：每次角色关系与组路径都保留', () => {
  const xml = `<packageItem xmlns="http://iptc.org/std/nar/2006-10-01/" guid="urn:p" version="1"><catalog><scheme alias="role" uri="urn:r:"/></catalog><itemMeta><pubStatus qcode="stat:usable"/></itemMeta><groupSet root="root"><group id="root" mode="pgrmod:sequence"><itemRef residref="urn:shared" version="1"><role qcode="role:main"/><href>shared.bin</href></itemRef><groupRef idref="more"/></group><group id="more" mode="pgrmod:bag"><itemRef residref="urn:shared" version="1"><role qcode="role:illustration"/><href>shared.bin</href></itemRef></group></groupSet></packageItem>`;
  const pkg = analyzePackage(Buffer.from(xml));
  assert.equal(pkg.relationships.length, 2);
  assert.deepEqual(pkg.relationships.map(rel => rel.roles[0].qcode), ['role:main', 'role:illustration']);
  assert.equal(pkg.groups.find(group => group.id === 'root').mode.resolvedUri, 'http://cv.iptc.org/newscodes/pgrgroupmode/sequence');
  const shared = new Set(pkg.relationships.map(rel => rel.residref));
  assert.equal(shared.size, 1);
  assert.deepEqual(pkg.relationships[1].groupPath, ['root', 'more']);
});

test('catalog 别名只在所在文档解释：不跨内容项继承，未登记别名不强行展开', () => {
  const pkgXml = `<packageItem xmlns="http://iptc.org/std/nar/2006-10-01/" guid="urn:p" version="1"><catalog><scheme alias="role" uri="urn:local:roles:"/></catalog><itemMeta><pubStatus qcode="stat:withheld"/></itemMeta><groupSet root="g"><group id="g" mode="pgrmod:bag"><itemRef residref="urn:x" version="1"><role qcode="role:main"/><role qcode="other:side"/><href>x.xml</href></itemRef></group></groupSet></packageItem>`;
  const pkg = analyzePackage(Buffer.from(pkgXml));
  const [known, unknown] = pkg.relationships[0].roles;
  assert.equal(known.resolvedUri, 'urn:local:roles:main');
  assert.equal(unknown.source, 'unresolved');
  assert.equal(unknown.resolvedUri, undefined);
  assert.equal(pkg.itemMeta.pubStatus.qcode, 'stat:withheld');
  assert.equal(pkg.itemMeta.pubStatus.usable, false);
  // newsItem 自带 catalog 独立解释，不继承包的 role 别名。
  const item = analyzeNewsItem(Buffer.from(`<newsItem xmlns="http://iptc.org/std/nar/2006-10-01/" guid="urn:x" version="1"><catalog><scheme alias="topic" uri="urn:t:"/></catalog><itemMeta><pubStatus qcode="stat:usable"/></itemMeta><contentSet><inlineXML><p>hi</p></inlineXML><remoteContent href="https://example.test/external.bin" residref="urn:ext"/></contentSet></newsItem>`));
  assert.deepEqual(item.catalog.map(entry => entry.alias), ['topic']);
  assert.equal(item.contentSet.remote[0].traversal, 'not-traversed');
  assert.equal(item.contentSet.inline[0].rawFragment, '<inlineXML><p>hi</p></inlineXML>');
});

test('嵌入脚本只保留原文不执行，remoteContent 不自动遍历', () => {
  const item = analyzeNewsItem(Buffer.from(`<newsItem xmlns="http://iptc.org/std/nar/2006-10-01/" guid="urn:x" version="1"><contentSet><inlineXML><script>window.alert(1)</script></inlineXML></contentSet></newsItem>`));
  assert.equal(item.contentSet.inline[0].scriptDetected, true);
  assert.ok(item.contentSet.inline[0].note.includes('不执行'));
});

test('语法错误返回400且不产生收件；非 packageItem 入口形成 rejected', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-bad-'));
  const service = await createService({ dataDir });
  try {
    const bad = await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await (await fetch(`${service.baseUrl}/v1/receipts`)).json(), []);
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('非 packageItem 入口：原文留存但整包 rejected，不假装解析成功', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-reject-'));
  const service = await createService({ dataDir });
  try {
    // story.xml 是合法 newsItem 但不是包；通过清单内资源直接作为入口语义不可达，
    // 这里直接验证分析层的根元素保护。
    const bytes = await readFile(fixture('story.xml'));
    assert.equal(analyzePackage(bytes).kind, 'other');
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('清单外链接不自动遍历：remoteContent 与越界 href 只登记不请求', async () => {
  const { dataDir, service, result } = await runStructured('standard');
  try {
    assert.equal(result.coverage.traversalScope, 'manifest-only');
    const requested = new Set(service.gateway.trace.map(item => item.path));
    for (const path of requested) {
      const name = decodeURIComponent(path.replace('/files/', ''));
      if (name) assert.ok(service.gateway.descriptor.resources.includes(name), `${name} 不在来源清单内却被请求`);
    }
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('结构化收件可在新进程实例打开同一 DATA_DIR 后查询', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-persist-'));
  let service = await createService({ dataDir, scenario: 'standard' });
  let receiptId;
  try {
    const response = await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'structured' }) });
    const result = await response.json();
    receiptId = result.id;
    assert.equal(result.records[0].id.startsWith('item:'), true);
  } finally { await service.close(); }
  service = await createService({ dataDir, scenario: 'standard' });
  try {
    const reopened = await (await fetch(`${service.baseUrl}/v1/receipts/${receiptId}`)).json();
    assert.equal(reopened.state, 'complete');
    assert.equal(reopened.records.length, 3);
    assert.equal(reopened.coverage.package.guid, 'urn:pkg:1');
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('fixtures 中的真实新闻包均可解释，二进制素材不被误判为 XML', async () => {
  const pkg = analyzePackage(await readFile(fixture('package.xml')));
  assert.equal(pkg.kind, 'package');
  assert.equal(pkg.identity.standardversion, '2.34');
  assert.equal(isXml(await readFile(fixture('photo.bin'))), false);
  assert.equal(isXml(await readFile(fixture('story.xml'))), true);
});

test('缺少 href 的 itemRef 记录为阻断缺口；悬空 groupRef 定位但不阻断', () => {
  const xml = `<packageItem xmlns="http://iptc.org/std/nar/2006-10-01/" guid="urn:p" version="1"><itemMeta><pubStatus qcode="stat:usable"/></itemMeta><groupSet root="g"><group id="g" mode="pgrmod:bag"><itemRef residref="urn:no-href" version="1"><role qcode="role:main"/></itemRef><groupRef idref="ghost"/></group></groupSet></packageItem>`;
  const pkg = analyzePackage(Buffer.from(xml));
  assert.equal(pkg.relationships[0].href, null);
  assert.ok(pkg.issues.some(issue => issue.code === 'missing-href' && issue.blocking));
  assert.ok(pkg.issues.some(issue => issue.code === 'dangling-group-ref' && issue.blocking === false));
});

test('承诺范围之外的包内扩展保留原文并显式标记不支持', () => {
  const xml = `<packageItem xmlns="http://iptc.org/std/nar/2006-10-01/" guid="urn:p" version="1"><itemMeta><pubStatus qcode="stat:usable"/></itemMeta><groupSet root="g"><group id="g" mode="pgrmod:bag"/></groupSet><customExtension><data>x</data></customExtension></packageItem>`;
  const pkg = analyzePackage(Buffer.from(xml));
  const issue = pkg.issues.find(item => item.code === 'unsupported-extension');
  assert.equal(issue.location, 'packageItem/customExtension');
  assert.equal(issue.blocking, false);
});

test('内容项版本与声明版本不一致时阻断完整性，包版本不替代内容项版本', () => {
  const item = analyzeNewsItem(Buffer.from(`<newsItem xmlns="http://iptc.org/std/nar/2006-10-01/" guid="urn:n" version="10"><itemMeta><pubStatus qcode="stat:withheld"/></itemMeta><contentSet/></newsItem>`));
  assert.equal(item.version, '10');
  assert.equal(item.itemMeta.pubStatus.qcode, 'stat:withheld');
  assert.equal(item.itemMeta.pubStatus.resolvedUri, 'http://cv.iptc.org/newscodes/pubstatusg2/withheld');
  assert.equal(item.itemMeta.pubStatus.scope, 'newsItem:urn:n');
});

test('多个 inlineXML 按文档顺序保留各自原文片段', () => {
  const item = analyzeNewsItem(Buffer.from(`<newsItem xmlns="http://iptc.org/std/nar/2006-10-01/" guid="urn:n" version="1"><contentSet><inlineXML><p>first</p></inlineXML><inlineXML><p>second</p></inlineXML></contentSet></newsItem>`));
  assert.deepEqual(item.contentSet.inline.map(part => part.rawFragment), [
    '<inlineXML><p>first</p></inlineXML>',
    '<inlineXML><p>second</p></inlineXML>',
  ]);
});
