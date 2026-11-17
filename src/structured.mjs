import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { parsePackage, parseNewsItem, expandRelationships, expandQcode, isAltMode, PUBSTATUS_USABLE } from './newsml.mjs';

const looksLikeXml = (bytes) => bytes.subarray(0, 128).toString('utf8').trimStart().startsWith('<');

// 结构化收件：按 NewsML-G2 包内关系取得素材。
// 只领取入口与来源清单内的 itemRef href；契约之外的链接不继续遍历。
export async function collectStructured({ descriptor, sourceBase, store }) {
  const allowed = new Set(descriptor.resources || []);
  const blobs = [];
  const blobIndex = new Map();
  const issues = [];
  const keepBlob = async (bytes) => {
    const blob = await store.blob(bytes);
    if (!blobIndex.has(blob.digest)) {
      blobIndex.set(blob.digest, blob);
      blobs.push(blob);
    }
    return blob;
  };

  const entry = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
  const entryBlob = await keepBlob(entry.bytes);
  const model = parsePackage(entry.bytes);

  if (!model.ok) {
    issues.push({ severity: 'error', code: 'not-a-package', message: model.error, href: descriptor.entry });
    const receipt = await store.save({
      state: 'rejected', mode: 'structured', product: descriptor.product,
      source: descriptor.entry, sourceVersion: entry.etag, metadata: inspect(entry.bytes),
      blobs, records: [], issues,
      coverage: {
        structured: true, pubStatus: null, usable: false,
        unusableReasons: ['入口文档无法解释为 NewsML-G2 新闻包'],
        relations: 0, received: 0, missing: 0, gaps: [], downloadedBytes: entry.bytes.length,
      },
      evidence: { package: { href: descriptor.entry, digest: entryBlob.digest, etag: entry.etag }, catalog: {}, items: [] },
    });
    return { receipt };
  }

  for (const warning of model.warnings) {
    issues.push({ severity: 'warning', code: 'package-warning', message: warning, href: descriptor.entry });
  }

  const evidence = {
    package: {
      href: descriptor.entry, digest: entryBlob.digest, etag: entry.etag,
      guid: model.guid, version: model.version, standard: model.standard, standardversion: model.standardversion,
    },
    catalog: model.catalog,
    items: [],
  };

  const { relations, issues: structureIssues } = expandRelationships(model);
  issues.push(...structureIssues);
  const evidencedHrefs = new Set();

  // 同一 href 只取一次；同一资源在多处使用时，各关系记录共享同一份字节证据。
  const fetchCache = new Map();
  const fetchHref = async (href) => {
    if (fetchCache.has(href)) return fetchCache.get(href);
    let result;
    if (!allowed.has(href)) {
      result = { fetched: false, reason: 'outside-contract' };
    } else {
      try {
        const received = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(href)}`);
        result = { fetched: true, ...received };
      } catch (error) {
        result = { fetched: false, reason: 'fetch-failed', message: error.message };
      }
    }
    fetchCache.set(href, result);
    return result;
  };

  const records = [];
  const usedIds = new Map();
  let overall = 0;
  for (const relation of relations) {
    const { member } = relation;
    const group = model.groups.get(relation.groupId);
    const alternatives = isAltMode(relation.groupMode, model.catalog)
      ? { group: relation.groupId, members: group.members.filter((item) => item.kind === 'itemRef').map((item) => item.residref) }
      : null;
    const roles = member.roles.length ? member.roles : [null];
    for (const roleRef of roles) {
      const expanded = roleRef?.qcode ? expandQcode(roleRef.qcode, model.catalog) : null;
      const role = expanded ? expanded.uri || expanded.qcode : roleRef?.literal || null;
      const baseId = [model.guid || descriptor.entry, relation.groupPath.join('/'), member.residref || '(无residref)', `v${member.version ?? '-'}`, expanded?.qcode || roleRef?.literal || '-'].join('|');
      const seen = (usedIds.get(baseId) || 0) + 1;
      usedIds.set(baseId, seen);
      const record = {
        id: seen > 1 ? `${baseId}#${seen}` : baseId,
        package: { guid: model.guid, version: model.version },
        residref: member.residref,
        version: member.version,
        role,
        roleQcode: expanded?.qcode || null,
        roleScheme: expanded?.scheme || null,
        group: { id: relation.groupId, mode: relation.groupMode, path: relation.groupPath },
        alternatives,
        order: { inGroup: relation.sequence, overall: overall++ },
        href: member.href,
        contentType: member.contentType,
        state: 'pending',
        blob: null,
        item: null,
        content: null,
      };
      if (!member.href) {
        record.state = 'unresolved';
        issues.push({ severity: 'error', code: 'missing-href', message: `关系 ${record.id} 没有资源定位`, record: record.id });
      } else {
        const fetched = await fetchHref(member.href);
        if (!fetched.fetched && fetched.reason === 'outside-contract') {
          record.state = 'blocked';
          issues.push({ severity: 'error', code: 'outside-contract', message: `资源 ${member.href} 不在来源清单内，按契约不继续遍历`, record: record.id, href: member.href });
        } else if (!fetched.fetched) {
          record.state = 'missing';
          issues.push({ severity: 'error', code: 'fetch-failed', message: `资源 ${member.href} 领取失败：${fetched.message}`, record: record.id, href: member.href });
        } else {
          record.state = 'received';
          record.blob = await keepBlob(fetched.bytes);
          const itemEvidence = { href: member.href, digest: record.blob.digest, etag: fetched.etag, guid: null, version: null };
          if (looksLikeXml(fetched.bytes)) {
            const item = parseNewsItem(fetched.bytes);
            if (item.ok) {
              itemEvidence.guid = item.guid;
              itemEvidence.version = item.version;
              record.item = { guid: item.guid, version: item.version, pubStatus: item.itemMeta.pubStatus?.qcode || null };
              record.content = item.content;
              if (item.guid && member.residref && item.guid !== member.residref) {
                issues.push({ severity: 'error', code: 'identity-mismatch', message: `资源 ${member.href} 的内容身份 ${item.guid} 与包内 residref ${member.residref} 不符`, record: record.id, href: member.href });
              }
              if (member.version && item.version && String(item.version) !== String(member.version)) {
                issues.push({ severity: 'warning', code: 'version-mismatch', message: `资源 ${member.href} 的内容项版本 ${item.version} 与包要求的版本 ${member.version} 不一致`, record: record.id, href: member.href });
              }
            } else {
              issues.push({ severity: 'warning', code: 'item-uninterpreted', message: `资源 ${member.href} 不是可解释的 newsItem：${item.error}`, record: record.id, href: member.href });
            }
          }
          if (!evidencedHrefs.has(member.href)) {
            evidencedHrefs.add(member.href);
            evidence.items.push(itemEvidence);
          }
        }
      }
      records.push(record);
    }
  }

  const gaps = records
    .filter((record) => record.state !== 'received')
    .map((record) => ({ record: record.id, residref: record.residref, href: record.href, state: record.state }));
  const hasErrors = issues.some((issue) => issue.severity === 'error');
  const state = hasErrors || gaps.length ? 'partial' : 'complete';

  const pubStatus = model.itemMeta.pubStatus;
  const packageUsable = Boolean(pubStatus && (PUBSTATUS_USABLE.has(pubStatus.qcode) || (pubStatus.uri && PUBSTATUS_USABLE.has(pubStatus.uri))));
  const unusableReasons = [];
  if (!packageUsable) unusableReasons.push(`包发布状态 ${pubStatus?.qcode || '缺失'} 不是 usable`);
  for (const gap of gaps) unusableReasons.push(`素材缺口：${gap.residref || gap.href || gap.record}`);
  if (hasErrors && !gaps.length) unusableReasons.push('包结构存在未解决问题');
  const usable = state === 'complete' && unusableReasons.length === 0;

  const receipt = await store.save({
    state, mode: 'structured', product: descriptor.product,
    source: descriptor.entry, sourceVersion: entry.etag, metadata: inspect(entry.bytes),
    blobs, records, issues,
    coverage: {
      structured: true,
      pubStatus: pubStatus?.qcode || null,
      pubStatusUri: pubStatus?.uri || null,
      usable,
      unusableReasons,
      relations: records.length,
      received: records.length - gaps.length,
      missing: gaps.length,
      gaps,
      downloadedBytes: blobs.reduce((total, blob) => total + blob.bytes, 0),
    },
    evidence,
  });
  return { receipt };
}
