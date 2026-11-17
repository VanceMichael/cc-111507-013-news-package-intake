import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const NAR_NAMESPACE = 'http://iptc.org/std/nar/2006-10-01/';
export const GROUP_MODE_URIS = {
  bag: 'http://cv.iptc.org/newscodes/packagegroupmode/bag',
  seq: 'http://cv.iptc.org/newscodes/packagegroupmode/seq',
  alt: 'http://cv.iptc.org/newscodes/packagegroupmode/alt',
};
export const PUBSTATUS_USABLE = new Set(['stat:usable', 'http://cv.iptc.org/newscodes/pubstatusg2/usable']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  parseTagValue: false,
  trimValues: true,
});

const localName = (name) => (name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name);

function* childElements(children) {
  for (const node of children || []) {
    if (!node || typeof node !== 'object') continue;
    for (const key of Object.keys(node)) {
      if (key === ':@' || key === '#text' || key.startsWith('?')) continue;
      yield { name: localName(key), children: node[key], attrs: node[':@'] || {} };
    }
  }
}

function firstElement(children, wanted) {
  for (const element of childElements(children)) if (element.name === wanted) return element;
  return null;
}

function attr(element, name) {
  const value = element?.attrs?.[`@_${name}`];
  return value === undefined || value === null ? null : String(value);
}

function textOf(element) {
  const parts = [];
  for (const node of element?.children || []) {
    if (node && typeof node === 'object' && '#text' in node) parts.push(String(node['#text']));
  }
  return parts.join('').trim();
}

function parseDocument(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  const verdict = XMLValidator.validate(text);
  if (verdict !== true) return { ok: false, error: `XML 无法解析：${verdict.err?.msg || '格式错误'}` };
  let doc;
  try {
    doc = parser.parse(text);
  } catch (error) {
    return { ok: false, error: `XML 无法解析：${error.message}` };
  }
  const roots = [];
  for (const node of doc) {
    if (!node || typeof node !== 'object') continue;
    for (const key of Object.keys(node)) {
      if (key === ':@' || key === '#text' || key.startsWith('?')) continue;
      roots.push({ name: localName(key), children: node[key], attrs: node[':@'] || {} });
    }
  }
  if (roots.length !== 1) return { ok: false, error: 'XML 缺少唯一根元素' };
  return { ok: true, root: roots[0] };
}

// qcode 展开只使用所在文档的 catalog；目录作用域不跨内容项继承。
export function expandQcode(qcode, catalog) {
  if (!qcode) return { qcode: qcode ?? null, uri: null, scheme: null };
  const index = qcode.indexOf(':');
  if (index > 0) {
    const scheme = catalog?.[qcode.slice(0, index)];
    if (scheme) return { qcode, uri: `${scheme}${qcode.slice(index + 1)}`, scheme };
  }
  return { qcode, uri: null, scheme: null };
}

function readCatalog(children) {
  const catalog = {};
  const catalogElement = firstElement(children, 'catalog');
  if (!catalogElement) return catalog;
  for (const scheme of childElements(catalogElement.children)) {
    if (scheme.name !== 'scheme') continue;
    const alias = attr(scheme, 'alias');
    const uri = attr(scheme, 'uri');
    if (alias && uri) catalog[alias] = uri;
  }
  return catalog;
}

function readItemMeta(children, catalog) {
  const meta = firstElement(children, 'itemMeta');
  if (!meta) return { itemClass: null, provider: null, versionCreated: null, pubStatus: null };
  const itemClass = firstElement(meta.children, 'itemClass');
  const provider = firstElement(meta.children, 'provider');
  const versionCreated = firstElement(meta.children, 'versionCreated');
  const pubStatus = firstElement(meta.children, 'pubStatus');
  return {
    itemClass: itemClass ? expandQcode(attr(itemClass, 'qcode'), catalog) : null,
    provider: provider ? attr(provider, 'literal') ?? (textOf(provider) || null) : null,
    versionCreated: versionCreated ? textOf(versionCreated) || null : null,
    pubStatus: pubStatus ? expandQcode(attr(pubStatus, 'qcode'), catalog) : null,
  };
}

function readItemRef(element) {
  const roles = [];
  for (const child of childElements(element.children)) {
    if (child.name !== 'role') continue;
    roles.push({ qcode: attr(child, 'qcode'), literal: attr(child, 'literal') });
  }
  const hrefElement = firstElement(element.children, 'href');
  const href = (hrefElement && textOf(hrefElement)) || attr(element, 'href');
  return {
    kind: 'itemRef',
    residref: attr(element, 'residref'),
    version: attr(element, 'version'),
    contentType: attr(element, 'contenttype'),
    href: href || null,
    roles,
  };
}

export function isAltMode(modeQcode, catalog) {
  const expanded = expandQcode(modeQcode, catalog);
  return modeQcode === 'pgrmod:alt' || expanded.uri === GROUP_MODE_URIS.alt;
}

// 解析 packageItem：包版本、目录作用域、发布状态与组结构分别保存。
export function parsePackage(bytes) {
  const parsed = parseDocument(bytes);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { root } = parsed;
  if (root.name !== 'packageItem') return { ok: false, error: `根元素 ${root.name} 不是 packageItem` };
  const warnings = [];
  const namespace = attr(root, 'xmlns');
  if (namespace !== NAR_NAMESPACE) {
    warnings.push(namespace ? `命名空间 ${namespace} 不是 NewsML-G2 NAR 命名空间` : '缺少 NewsML-G2 NAR 命名空间声明');
  }
  const catalog = readCatalog(root.children);
  const itemMeta = readItemMeta(root.children, catalog);
  const groupSet = firstElement(root.children, 'groupSet');
  if (!groupSet) return { ok: false, error: 'packageItem 缺少 groupSet' };
  const groups = new Map();
  for (const groupElement of childElements(groupSet.children)) {
    if (groupElement.name !== 'group') continue;
    const id = attr(groupElement, 'id');
    if (!id) {
      warnings.push('存在缺少 id 的 group，已跳过');
      continue;
    }
    if (groups.has(id)) warnings.push(`组 ${id} 重复定义，保留后者`);
    const members = [];
    for (const member of childElements(groupElement.children)) {
      if (member.name === 'itemRef') members.push(readItemRef(member));
      else if (member.name === 'groupRef') members.push({ kind: 'groupRef', idref: attr(member, 'idref') });
    }
    groups.set(id, { id, mode: attr(groupElement, 'mode'), members });
  }
  return {
    ok: true,
    guid: attr(root, 'guid'),
    version: attr(root, 'version'),
    standard: attr(root, 'standard'),
    standardversion: attr(root, 'standardversion'),
    conformance: attr(root, 'conformance'),
    namespace,
    catalog,
    itemMeta,
    rootId: attr(groupSet, 'root'),
    groups,
    warnings,
  };
}

// 展开包内关系：保留组路径、组内顺序与备选组身份；环路记录为问题而不是无限展开。
export function expandRelationships(model, { limit = 500 } = {}) {
  const relations = [];
  const issues = [];
  const reached = new Set();
  let visits = 0;
  let halted = false;
  const visit = (groupId, path, stack) => {
    if (halted) return;
    if (stack.includes(groupId)) {
      issues.push({ severity: 'error', code: 'group-cycle', message: `groupRef 形成环路：${[...stack, groupId].join(' → ')}`, group: groupId, path });
      return;
    }
    const group = model.groups.get(groupId);
    if (!group) {
      issues.push({ severity: 'error', code: 'unknown-group', message: `groupRef 指向未定义的组 ${groupId}`, group: groupId, path });
      return;
    }
    visits += 1;
    if (visits > limit) {
      halted = true;
      issues.push({ severity: 'error', code: 'expansion-limit', message: `组展开超过上限 ${limit}，已停止`, group: groupId, path });
      return;
    }
    reached.add(groupId);
    const nextPath = [...path, groupId];
    let position = 0;
    for (const member of group.members) {
      const sequence = position;
      position += 1;
      if (member.kind === 'groupRef') {
        visit(member.idref, nextPath, [...stack, groupId]);
        continue;
      }
      relations.push({ groupPath: nextPath, groupId, groupMode: group.mode, sequence, member });
    }
  };
  if (model.rootId) visit(model.rootId, [], []);
  else issues.push({ severity: 'error', code: 'missing-root', message: 'groupSet 缺少 root 指向' });
  for (const id of model.groups.keys()) {
    if (!reached.has(id)) issues.push({ severity: 'info', code: 'unreachable-group', message: `组 ${id} 从 root 不可达，未展开`, group: id });
  }
  return { relations, issues };
}

// 解析内容项：仅限 newsItem 的 contentSet（inlineXML/remoteContent）。
// remoteContent 的链接只记录为引用，不继续遍历；未列出扩展保留原文标记，不假装解析。
export function parseNewsItem(bytes) {
  const parsed = parseDocument(bytes);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { root } = parsed;
  if (root.name !== 'newsItem') return { ok: false, error: `根元素 ${root.name} 不是 newsItem` };
  const catalog = readCatalog(root.children);
  const itemMeta = readItemMeta(root.children, catalog);
  const content = [];
  const contentSet = firstElement(root.children, 'contentSet');
  if (contentSet) {
    for (const element of childElements(contentSet.children)) {
      if (element.name === 'inlineXML') content.push({ kind: 'inlineXML' });
      else if (element.name === 'remoteContent') {
        content.push({ kind: 'remoteContent', href: attr(element, 'href'), contentType: attr(element, 'contenttype'), size: attr(element, 'size'), fetched: false });
      } else content.push({ kind: element.name, supported: false });
    }
  }
  return {
    ok: true,
    guid: attr(root, 'guid'),
    version: attr(root, 'version'),
    itemMeta,
    content,
  };
}
