import { createHash } from 'node:crypto';
import { receiveBytes } from './http-client.mjs';
import { analyzePackage, analyzeNewsItem, parseXml, isXml } from './newsml.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function recordId(relationship) {
  if (relationship.residref) return `item:${relationship.residref.replace(/[^a-zA-Z0-9._:=-]+/g, '_')}`;
  if (relationship.href) return `href:${relationship.href.replace(/[^a-zA-Z0-9._=-]+/g, '_')}`;
  return `ref:${relationship.groupPath.join('_')}-${relationship.ordinal}`;
}

export async function collectStructured({ descriptor, sourceBase, store }) {
  const issues = [];
  const evidence = [];
  const externalReferences = [];
  const allowed = new Set(descriptor.resources || []);
  const fetched = new Map();
  const blobs = [];

  // 仅取得来源清单内的入口；清单之外的链接不自动遍历。
  const entryHref = descriptor.entry;
  if (!allowed.has(entryHref)) {
    return { httpStatus: 400, error: '入口资源不在来源清单内，拒绝收件' };
  }
  const entryResponse = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(entryHref)}`);
  fetched.set(entryHref, entryResponse);

  let pkg;
  try {
    pkg = analyzePackage(entryResponse.bytes);
  } catch (error) {
    return { httpStatus: 400, error: error.message };
  }
  const entryBlob = await store.blob(entryResponse.bytes);
  blobs.push(entryBlob);
  evidence.push({
    role: 'package-entry',
    href: entryHref,
    digest: entryBlob.digest,
    bytes: entryBlob.bytes,
    sourceEtag: entryResponse.etag,
  });

  if (pkg.kind !== 'package') {
    return {
      receipt: await store.save({
        state: 'rejected', mode: 'structured', product: descriptor.product,
        source: entryHref, sourceVersion: entryResponse.etag,
        blobs, records: [], issues: [{ code: 'unsupported-root', location: 'packageItem',
          message: `入口根元素为「${pkg.root}」，不是 NewsML-G2 packageItem，无法按新闻包解释`, blocking: true }],
        coverage: { structured: true, packageState: 'rejected', editable: false,
          downloadedBytes: entryResponse.bytes.length, expectedItems: 0, availableItems: 0,
          relationships: 0, traversalScope: 'manifest-only', externalReferences, evidence },
      }),
    };
  }

  for (const issue of pkg.issues) issues.push(issue);

  // 按关系顺序去重取得清单内资源；同一份字节只落盘一次。
  for (const relationship of pkg.relationships) {
    const href = relationship.href;
    if (!href) continue;
    if (fetched.has(href)) continue;
    if (!allowed.has(href)) {
      issues.push({ code: 'resource-outside-manifest', location: `itemRef:${relationship.residref || href}`,
        message: `资源「${href}」不在来源清单内，按契约不自动取得`, blocking: true });
      continue;
    }
    try {
      const response = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(href)}`);
      fetched.set(href, response);
      const blob = await store.blob(response.bytes);
      blobs.push(blob);
      evidence.push({ role: 'content-item', href, digest: blob.digest, bytes: blob.bytes, sourceEtag: response.etag });
    } catch (error) {
      fetched.set(href, { failed: true, error: error.message });
      issues.push({ code: 'resource-unavailable', location: `itemRef:${relationship.residref || href}`,
        message: `资源「${href}」无法取得：${error.message}；备选素材保持独立关系，不替代原稿`, blocking: true });
    }
  }

  const records = [];
  const recordIndex = new Map();
  pkg.relationships.forEach((relationship, index) => {
    const id = recordId(relationship);
    let record = recordIndex.get(id);
    if (!record) {
      record = {
        id,
        residref: relationship.residref,
        href: relationship.href,
        itemVersion: relationship.version,
        packageGuid: pkg.identity.guid,
        packageVersion: pkg.identity.version,
        available: false,
        blob: null,
        content: null,
        roles: [],
        usages: [],
        issues: [],
      };
      recordIndex.set(id, record);
      records.push(record);
    }
    // 同一资源在多处使用：每个角色关系都忠实保留，不合并角色。
    record.roles.push(...relationship.roles);
    record.usages.push({
      ordinal: index,
      groupId: relationship.groupId,
      groupMode: relationship.groupMode,
      groupPath: relationship.groupPath,
      position: relationship.ordinal,
      depth: relationship.depth,
      alternativeGroup: relationship.alternativeGroup,
      roles: relationship.roles,
    });
  });

  // 版本核对与内容项解释；包版本不替代内容项版本。
  for (const record of records) {
    const href = record.href;
    if (!href) continue;
    const response = fetched.get(href);
    if (!response || response.failed) {
      record.issues.push({ code: 'not-downloaded', location: `itemRef:${record.residref || href}`,
        message: '该关系指向的资源未取得，关系保留但无可用字节', blocking: true });
      continue;
    }
    record.available = true;
    record.blob = { digest: sha256(response.bytes), bytes: response.bytes.length, sourceEtag: response.etag };
    if (!isXml(response.bytes)) {
      record.content = { kind: 'binary', note: '非 XML 素材，仅按字节留存' };
      continue;
    }
    let analysis;
    try {
      const { parsed } = parseXml(response.bytes);
      const rootName = Object.keys(parsed)[0];
      if (rootName !== 'newsItem') {
        record.content = { kind: rootName === 'packageItem' ? 'nested-package' : 'other-xml',
          root: rootName, note: '引用项不是 newsItem，按承诺范围仅保留原文不解释其关系' };
        issues.push({ code: 'unsupported-item-type', location: `itemRef:${record.residref || href}`,
          message: `引用项根元素为「${rootName}」，内容项解释范围仅限 newsItem，原文已保留`, blocking: false });
        continue;
      }
      analysis = analyzeNewsItem(response.bytes);
      if (analysis.version !== undefined && record.itemVersion !== null && analysis.version !== record.itemVersion) {
        const message = `内容项实际版本 ${analysis.version} 与 itemRef 声明版本 ${record.itemVersion} 不一致，以内容项自身版本为准`;
        issues.push({ code: 'item-version-mismatch', location: `newsItem:${record.residref || href}`, message, blocking: true });
        record.issues.push({ code: 'item-version-mismatch', message, blocking: true });
      }
      if (analysis.itemMeta.pubStatus && !analysis.itemMeta.pubStatus.usable) {
        issues.push({ code: 'item-not-usable', location: `newsItem:${record.residref || href}`,
          message: `内容项出版状态为 ${analysis.itemMeta.pubStatus.qcode}，保留但不视为可用素材`, blocking: false });
      }
      for (const remote of analysis.contentSet.remote) {
        externalReferences.push({ item: record.residref || href, href: remote.href,
          kind: 'remoteContent', traversal: 'not-traversed', note: remote.note });
      }
      if (analysis.unsupportedExtensions.length) {
        issues.push({ code: 'unsupported-extension', location: `newsItem:${record.residref || href}`,
          message: `内容项含未承诺扩展：${analysis.unsupportedExtensions.join(',')}，原文已保留`, blocking: false });
      }
      record.content = {
        kind: 'newsItem',
        guid: analysis.guid,
        version: analysis.version,
        catalogScope: `newsItem:${analysis.guid || 'unknown'}`,
        catalog: analysis.catalog,
        pubStatus: analysis.itemMeta.pubStatus || null,
        inlineXml: analysis.contentSet.inline,
        remoteContent: analysis.contentSet.remote,
      };
    } catch (error) {
      record.content = { kind: 'unparsed-xml', note: 'XML 字节无法按承诺范围解释，原文已保留', error: error.message };
      issues.push({ code: 'item-parse-failed', location: `itemRef:${record.residref || href}`,
        message: error.message, blocking: true });
    }
  }

  const expectedItems = records.length;
  const availableItems = records.filter(record => record.available).length;
  const blockingIssues = issues.filter(issue => issue.blocking);
  const packagePubStatus = pkg.itemMeta.pubStatus;
  const packageEditable = packagePubStatus ? packagePubStatus.usable : false;

  let state;
  if (blockingIssues.length > 0) state = 'partial';
  else state = 'complete';

  const coverage = {
    structured: true,
    packageState: state,
    editable: state === 'complete' && packageEditable,
    package: {
      guid: pkg.identity.guid,
      version: pkg.identity.version,
      standardversion: pkg.identity.standardversion,
      pubStatus: packagePubStatus || null,
      catalogScope: `packageItem:${pkg.identity.guid || 'unknown'}`,
      catalog: pkg.catalog,
    },
    versioning: {
      packageVersion: pkg.identity.version,
      itemVersions: records.map(record => ({ id: record.id, declared: record.itemVersion,
        observed: record.content?.version ?? null })),
      note: '包版本与内容项版本分别记录，包版本不替代内容项版本',
    },
    groups: pkg.groups,
    ordering: pkg.relationships.map((relationship, ordinal) => ({
      ordinal, residref: relationship.residref, href: relationship.href,
      groupPath: relationship.groupPath, groupMode: relationship.groupMode, position: relationship.ordinal,
    })),
    expectedItems,
    availableItems,
    missingItems: records.filter(record => !record.available).map(record => ({ id: record.id, href: record.href, residref: record.residref })),
    relationships: pkg.relationships.length,
    traversalScope: 'manifest-only',
    downloadedBytes: Array.from(fetched.values()).filter(item => !item.failed).reduce((sum, item) => sum + item.bytes.length, 0),
    externalReferences,
    evidence,
  };

  return {
    receipt: await store.save({
      state, mode: 'structured', product: descriptor.product,
      source: entryHref, sourceVersion: entryResponse.etag,
      blobs, records, issues, coverage,
    }),
  };
}
