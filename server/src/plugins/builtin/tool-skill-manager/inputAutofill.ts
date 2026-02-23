export interface SkillInputSpec {
  type?: string;
  optional?: boolean;
  label?: string;
}

interface SkillInputEntry {
  name: string;
  spec: SkillInputSpec;
}

type InputRole = 'message' | 'tone' | 'purpose' | 'context' | 'unknown';

const ROLE_ALIASES: Record<Exclude<InputRole, 'unknown'>, string[]> = {
  message: [
    'message', 'msg', 'text', 'content', 'input', 'reply', 'response',
    'cnreply', 'chinesereply', 'source', 'sourcetext', 'originaltext',
    '消息', '文本', '内容', '回复', '原文', '待翻译', '翻译内容', '输入',
  ],
  tone: [
    'tone', 'style', 'voice', 'mood', 'register',
    '语气', '口吻', '风格', '语调',
  ],
  purpose: [
    'purpose', 'goal', 'intent', 'objective', 'target',
    '目的', '目标', '意图', '诉求',
  ],
  context: [
    'context', 'background', 'customercontext', 'history', 'thread',
    '上下文', '背景', '客户消息', '客户原话', '历史消息',
  ],
};

function normalizeKey(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[`'"“”‘’\s_\-]/g, '')
    .trim();
}

function isTextLike(type?: string): boolean {
  return !type || type === 'text' || type === 'textarea';
}

function hasValue(value: any, type: string): boolean {
  if (value == null) return false;
  if (type === 'url_list') {
    return Array.isArray(value) ? value.some((v) => String(v || '').trim().length > 0) : String(value).trim().length > 0;
  }
  if (type === 'image') {
    if (Array.isArray(value)) return value.length > 0;
    return String(value || '').trim().length > 0 && !String(value).includes('[image:missing_attachment_');
  }
  if (type === 'file') {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return String(value.content || value.base64 || '').trim().length > 0;
    return String(value || '').trim().length > 0;
  }
  return String(value || '').trim().length > 0;
}

function cleanValue(raw: string): string {
  let value = String(raw || '').trim();
  value = value.replace(/^["'“‘「『]+/, '').replace(/["'”’」』]+$/, '').trim();
  return value;
}

function detectRole(name: string, spec: SkillInputSpec): InputRole {
  const combined = `${name} ${spec.label || ''}`;
  const normalized = normalizeKey(combined);
  if (!normalized) return 'unknown';

  for (const [role, aliases] of Object.entries(ROLE_ALIASES) as Array<[Exclude<InputRole, 'unknown'>, string[]]>) {
    if (aliases.some((alias) => normalized.includes(alias))) return role;
  }
  return 'unknown';
}

function pickVariableByRole(entries: SkillInputEntry[], role: Exclude<InputRole, 'unknown'>): string | null {
  const matches = entries.filter((entry) => detectRole(entry.name, entry.spec) === role);
  if (matches.length === 0) return null;

  // Prefer required variables when both required/optional exist for the same semantic role.
  matches.sort((a, b) => Number(!!a.spec.optional) - Number(!!b.spec.optional));
  return matches[0]?.name || null;
}

function findVariableForNamedKey(entries: SkillInputEntry[], rawKey: string): string | null {
  const key = normalizeKey(rawKey);
  if (!key) return null;

  // 1) Exact variable/label match.
  for (const entry of entries) {
    const varKey = normalizeKey(entry.name);
    const labelKey = normalizeKey(entry.spec.label || '');
    if (key === varKey || (labelKey && key === labelKey)) return entry.name;
  }

  // 2) Alias-based semantic match.
  for (const [role, aliases] of Object.entries(ROLE_ALIASES) as Array<[Exclude<InputRole, 'unknown'>, string[]]>) {
    if (!aliases.includes(key)) continue;
    const mapped = pickVariableByRole(entries, role);
    if (mapped) return mapped;
  }

  return null;
}

function extractNamedValues(message: string): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  const segments = String(message || '')
    .split(/\r?\n|[；;]/)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const match = segment.match(/^([\w\u4e00-\u9fff-]{1,40})\s*[:：]\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = cleanValue(match[2]);
    if (!key || !value) continue;
    pairs.push({ key, value });
  }

  return pairs;
}

function extractQuotedCandidates(message: string): string[] {
  const text = String(message || '');
  const regexes = [
    /“([^”\n]{2,300})”/g,
    /‘([^’\n]{2,300})’/g,
    /"([^"\n]{2,300})"/g,
    /'([^'\n]{2,300})'/g,
    /「([^」\n]{2,300})」/g,
    /『([^』\n]{2,300})』/g,
  ];
  const out: string[] = [];
  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const candidate = cleanValue(match[1]);
      if (!candidate) continue;
      if (/(语气|口吻|风格|tone|purpose|目的|context|上下文)/i.test(candidate)) continue;
      out.push(candidate);
    }
  }
  return out;
}

function extractTone(message: string): string | null {
  const text = String(message || '');
  const zh = text.match(/(?:语气|口吻|风格)\s*(?:要|用|为|是|改成|偏)?\s*([^\n，。；;,.!?]{1,80})/i);
  if (zh && zh[1]) return cleanValue(zh[1]);

  const en = text.match(/(?:tone|style)\s*(?:to|as|be|is|:)?\s*([a-zA-Z][a-zA-Z\s-]{1,80})/i);
  if (en && en[1]) return cleanValue(en[1]);
  return null;
}

function extractPurpose(message: string): string | null {
  const text = String(message || '');
  const zh = text.match(/(?:目的|目标|诉求|希望|想要|为了)\s*(?:是|为|:|：)?\s*([^\n。！？]{1,120})/i);
  if (zh && zh[1]) return cleanValue(zh[1]);

  const en = text.match(/(?:purpose|goal|intent|objective)\s*(?:is|to|:)?\s*([^\n.?!]{1,120})/i);
  if (en && en[1]) return cleanValue(en[1]);
  return null;
}

function extractContext(message: string): string | null {
  const text = String(message || '');
  const direct = text.match(/(?:上下文|context|背景)\s*(?:是|为|:|：)?\s*([^\n。！？]{1,180})/i);
  if (direct && direct[1]) return cleanValue(direct[1]);

  const customer = text.match(/(?:客户(?:说|发来|问)?|对方(?:说|问)?)([^。！？\n]{2,180})/i);
  if (customer && customer[1]) return cleanValue(customer[1]);
  return null;
}

function extractUrls(message: string): string[] {
  const text = String(message || '');
  const matches = text.match(/https?:\/\/[^\s，,；;"'<>]+/g) || [];
  return Array.from(new Set(matches.map((item) => item.trim()).filter(Boolean)));
}

export function inferInputsFromNaturalLanguage(opts: {
  message: string;
  inputSpecs: Map<string, SkillInputSpec>;
  existingInputs?: Record<string, any>;
}): Record<string, any> {
  const message = String(opts.message || '').trim();
  if (!message) return {};

  const existing = opts.existingInputs || {};
  const entries: SkillInputEntry[] = Array.from(opts.inputSpecs.entries()).map(([name, spec]) => ({
    name,
    spec: spec || {},
  }));
  if (entries.length === 0) return {};

  const inferred: Record<string, any> = {};
  const setIfMissing = (name: string | null, rawValue: any) => {
    if (!name) return;
    const entry = entries.find((item) => item.name === name);
    if (!entry) return;

    const type = String(entry.spec.type || 'text');
    if (hasValue(existing[name], type)) return;
    if (hasValue(inferred[name], type)) return;

    if (type === 'url_list') {
      const next = Array.isArray(rawValue)
        ? rawValue.map((v) => String(v || '').trim()).filter(Boolean)
        : String(rawValue || '')
            .split(/[\s,\n]+/)
            .map((v) => v.trim())
            .filter((v) => /^https?:\/\//.test(v));
      if (next.length > 0) inferred[name] = next;
      return;
    }

    if (!isTextLike(type)) return;
    const value = cleanValue(String(rawValue || ''));
    if (!value) return;
    inferred[name] = value;
  };

  // 1) Explicit named values, e.g. "tone: friendly".
  for (const pair of extractNamedValues(message)) {
    const varName = findVariableForNamedKey(entries, pair.key);
    setIfMissing(varName, pair.value);
  }

  // 2) URL inference for url_list inputs.
  const urls = extractUrls(message);
  if (urls.length > 0) {
    const urlVar = entries.find((item) => String(item.spec.type || '') === 'url_list')?.name || null;
    setIfMissing(urlVar, urls);
  }

  // 3) Semantic phrase extraction for common optional fields.
  const toneVar = pickVariableByRole(entries, 'tone');
  const purposeVar = pickVariableByRole(entries, 'purpose');
  const contextVar = pickVariableByRole(entries, 'context');
  setIfMissing(toneVar, extractTone(message));
  setIfMissing(purposeVar, extractPurpose(message));
  setIfMissing(contextVar, extractContext(message));

  // 4) Quoted user text is commonly the "main content" input (e.g., cn_reply).
  const messageVar =
    pickVariableByRole(entries, 'message')
    || (() => {
      const candidates = entries.filter((entry) => {
        const type = String(entry.spec.type || 'text');
        if (!isTextLike(type)) return false;
        return detectRole(entry.name, entry.spec) === 'unknown';
      });
      if (candidates.length === 1) return candidates[0].name;
      const requiredCandidates = candidates.filter((entry) => !entry.spec.optional);
      return requiredCandidates.length === 1 ? requiredCandidates[0].name : null;
    })();

  const quoted = extractQuotedCandidates(message);
  if (quoted.length > 0) {
    setIfMissing(messageVar, quoted[0]);
  }

  return inferred;
}
