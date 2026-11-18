import { XMLParser, XMLValidator } from 'fast-xml-parser';

// NewsML-G2 标准目录中本服务承诺解释的别名；包内 catalog 同名别名优先于标准别名。
const STANDARD_ALIASES = new Map([
  ['pgrmod', 'http://cv.iptc.org/newscodes/pgrgroupmode/'],
  ['stat', 'http://cv.iptc.org/newscodes/pubstatusg2/'],
]);

const PACKAGE_CHILDREN = new Set(['catalog', 'itemMeta', 'groupSet', 'rightsInfo', 'itemMetaExtProperty']);
const ITEM_CHILDREN = new Set(['catalog', 'itemMeta', 'contentMeta', 'contentSet', 'rightsInfo', 'itemMetaExtProperty']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseAttributeValue: false,
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(node, name) {
  const value = node?.[`@_${name}`];
  return Array.isArray(value) ? value[0] : value;
}

function childText(node, name) {
  const value = node?.[name];
  if (value === undefined) return undefined;
  const first = asArray(value)[0];
  if (first === undefined) return undefined;
  return typeof first === 'object' ? first['#text'] : first;
}

export function parseXml(bytes) {
  const text = bytes.toString('utf8');
  const validity = XMLValidator.validate(text);
  if (validity !== true) {
    const err = validity?.err || {};
    const where = err.line ? `（第 ${err.line} 行第 ${err.col || 1} 列）` : '';
    throw new Error(`XML 语法错误${where}：${err.msg || '无法解析'}`);
  }
  return { text, parsed: parser.parse(text) };
}

export function isXml(bytes) {
  return XMLValidator.validate(bytes.toString('utf8')) === true;
}

// catalog 的 scheme alias 只在所在文档内有效，不跨内容项继承。
export function buildCatalog(docNode, { scope }) {
  const entries = [];
  for (const scheme of asArray(docNode?.catalog?.scheme)) {
    const alias = attr(scheme, 'alias');
    const uri = attr(scheme, 'uri');
    if (!alias || !uri) continue;
    entries.push({ alias, uri, scope, source: 'document-catalog' });
  }
  return {
    scope,
    entries,
    resolve(qcode) {
      if (typeof qcode !== 'string' || !qcode.includes(':')) {
        return { qcode, resolvedUri: undefined, alias: undefined, scope, source: 'unresolved' };
      }
      const alias = qcode.slice(0, qcode.indexOf(':'));
      const local = qcode.slice(qcode.indexOf(':') + 1);
      const localEntry = entries.find(entry => entry.alias === alias);
      if (localEntry) {
        return { qcode, resolvedUri: `${localEntry.uri}${local}`, alias, scope, source: 'document-catalog' };
      }
      if (STANDARD_ALIASES.has(alias)) {
        return { qcode, resolvedUri: `${STANDARD_ALIASES.get(alias)}${local}`, alias, scope, source: 'standard-catalog' };
      }
      return { qcode, resolvedUri: undefined, alias, scope, source: 'unresolved' };
    },
  };
}

function readItemMeta(node, catalog) {
  const meta = node?.itemMeta || {};
  const pubStatusQcode = attr(asArray(meta.pubStatus)[0], 'qcode');
  return {
    itemClass: attr(asArray(meta.itemClass)[0], 'qcode'),
    provider: attr(asArray(meta.provider)[0], 'literal'),
    versionCreated: childText(meta, 'versionCreated'),
    pubStatus: pubStatusQcode
      ? { qcode: pubStatusQcode, ...catalog.resolve(pubStatusQcode), usable: pubStatusQcode === 'stat:usable' }
      : undefined,
  };
}

// 截取源文档中某元素的原始片段，保留未解析的原文证据。
function rawElement(text, tagName, fromIndex = 0) {
  const open = text.indexOf(`<${tagName}`, fromIndex);
  if (open < 0) return undefined;
  const close = text.indexOf('>', open);
  if (close < 0) return undefined;
  if (text[close - 1] === '/') return { fragment: text.slice(open, close + 1), nextIndex: close + 1 };
  const endTag = `</${tagName}>`;
  const end = text.indexOf(endTag, close);
  if (end < 0) return undefined;
  return { fragment: text.slice(open, end + endTag.length), nextIndex: end + endTag.length };
}

function hasScriptNode(node) {
  if (!node || typeof node !== 'object') return false;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'script') return true;
    if (key.startsWith('@_') || typeof value !== 'object') continue;
    if (asArray(value).some(child => hasScriptNode(child))) return true;
  }
  return false;
}

function analyzeContentSet(newsNode, text) {
  const contentSet = asArray(newsNode.contentSet)[0] || {};
  const inline = [];
  let searchFrom = 0;
  for (const inlineNode of asArray(contentSet.inlineXML)) {
    const raw = rawElement(text, 'inlineXML', searchFrom);
    if (raw) searchFrom = raw.nextIndex;
    const elementNames = Object.keys(inlineNode).filter(key => !key.startsWith('@_'));
    const scriptDetected = hasScriptNode(inlineNode) || /<script[\s>]/i.test(raw?.fragment || '');
    inline.push({
      kind: 'inlineXML',
      elementNames,
      scriptDetected,
      rawFragment: raw?.fragment,
      note: scriptDetected ? '检测到嵌入脚本，仅保留原文，不执行' : '内联 XML 仅保留原文与结构，不执行',
    });
  }
  const remote = [];
  for (const remoteNode of asArray(contentSet.remoteContent)) {
    const href = attr(remoteNode, 'href') || childText(remoteNode, 'href');
    remote.push({
      kind: 'remoteContent',
      href,
      residref: attr(remoteNode, 'residref'),
      version: attr(remoteNode, 'version'),
      traversal: 'not-traversed',
      note: '外部内容链接不在包关系契约内，不自动取得',
    });
  }
  return { inline, remote };
}

// 解释 newsItem：只承诺 contentSet 的 remoteContent/inlineXML 范围。
export function analyzeNewsItem(bytes) {
  const { text, parsed } = parseXml(bytes);
  const node = parsed.newsItem;
  if (!node) return { kind: 'other', root: Object.keys(parsed)[0] };
  const catalog = buildCatalog(node, { scope: `newsItem:${attr(node, 'guid') || 'unknown'}` });
  const unknownChildren = Object.keys(node).filter(key => !key.startsWith('@_') && !ITEM_CHILDREN.has(key));
  const contentSet = analyzeContentSet(node, text);
  return {
    kind: 'newsItem',
    guid: attr(node, 'guid'),
    version: attr(node, 'version'),
    catalog: catalog.entries,
    itemMeta: readItemMeta(node, catalog),
    contentSet,
    unsupportedExtensions: unknownChildren,
  };
}

// 解释 packageItem：groupSet/group/groupRef/itemRef 与 bag/sequence/alt 关系。
export function analyzePackage(bytes) {
  const { text, parsed } = parseXml(bytes);
  const rootName = Object.keys(parsed)[0];
  if (rootName !== 'packageItem') {
    return { kind: 'other', root: rootName, bytes: bytes.length };
  }
  const node = parsed.packageItem;
  const catalog = buildCatalog(node, { scope: `packageItem:${attr(node, 'guid') || 'unknown'}` });
  const unknownChildren = Object.keys(node).filter(key => !key.startsWith('@_') && !PACKAGE_CHILDREN.has(key));
  const groupSet = asArray(node.groupSet)[0] || {};
  const rootId = attr(groupSet, 'root');

  const groups = new Map();
  for (const groupNode of asArray(groupSet.group)) {
    const id = attr(groupNode, 'id');
    if (!id) continue;
    const modeQcode = attr(groupNode, 'mode');
    const childCount = asArray(groupNode.itemRef).length + asArray(groupNode.groupRef).length;
    groups.set(id, {
      id,
      mode: modeQcode ? { qcode: modeQcode, ...catalog.resolve(modeQcode) } : undefined,
      childCount,
    });
  }

  const relationships = [];
  const issues = [];
  const activeGroups = new Set();

  function walk(groupId, groupPath, depth) {
    const groupNode = asArray(groupSet.group).find(candidate => attr(candidate, 'id') === groupId);
    if (!groupNode) {
      issues.push({ code: 'dangling-group-ref', location: `groupSet/${groupPath.join('/')}`,
        message: `groupRef 指向不存在的组「${groupId}」，该引用不展开`, blocking: false });
      return;
    }
    if (activeGroups.has(groupId)) {
      issues.push({ code: 'group-cycle', location: `groupSet/${groupPath.join('/')}`,
        message: `组引用形成循环：${groupPath.join(' > ')}，已停止沿该路径继续展开`, blocking: false });
      return;
    }
    activeGroups.add(groupId);
    // 按 XML 文档顺序遍历子元素，itemRef 与 groupRef 交错出现时顺序必须保留。
    const orderedChildren = [];
    for (const [key, value] of Object.entries(groupNode)) {
      if (key === 'itemRef' || key === 'groupRef') orderedChildren.push(...asArray(value).map(child => [key, child]));
    }
    let ordinal = 0;
    for (const [key, childNode] of orderedChildren) {
      ordinal += 1;
      if (key === 'itemRef') {
        const itemRef = childNode;
        const href = childText(itemRef, 'href') || attr(itemRef, 'href');
        const residref = attr(itemRef, 'residref');
        const roles = asArray(itemRef.role).map(roleNode => {
          const qcode = attr(roleNode, 'qcode');
          return qcode ? { qcode, ...catalog.resolve(qcode) } : { qcode: attr(roleNode, 'literal'), resolvedUri: undefined, source: 'literal' };
        });
        relationships.push({
          residref: residref || null,
          version: attr(itemRef, 'version') || null,
          href: href || null,
          roles,
          groupId,
          groupMode: groups.get(groupId)?.mode?.qcode || null,
          groupPath: groupPath.slice(),
          ordinal,
          depth,
          alternativeGroup: groups.get(groupId)?.mode?.qcode === 'pgrmod:alt' ? groupId : null,
        });
        if (!href) {
          issues.push({ code: 'missing-href', location: `groupSet/${groupPath.join('/')}#${ordinal}`,
            message: `内容项「${residref || '未命名'}」缺少资源定位 href，无法取得字节`, blocking: true });
        }
      } else {
        const idref = attr(childNode, 'idref');
        walk(idref, groupPath.concat(idref), depth + 1);
      }
    }
    activeGroups.delete(groupId);
  }

  if (rootId) walk(rootId, [rootId], 0);
  for (const unknown of unknownChildren) {
    issues.push({ code: 'unsupported-extension', location: `packageItem/${unknown}`,
      message: `包内出现承诺范围之外的扩展元素「${unknown}」，原文已保留但不解释`, blocking: false });
  }

  return {
    kind: 'package',
    identity: {
      guid: attr(node, 'guid'),
      version: attr(node, 'version'),
      standard: attr(node, 'standard'),
      standardversion: attr(node, 'standardversion'),
      conformance: attr(node, 'conformance'),
    },
    catalog: catalog.entries,
    itemMeta: readItemMeta(node, catalog),
    rootGroup: rootId,
    groups: Array.from(groups.values()),
    relationships,
    issues,
  };
}
