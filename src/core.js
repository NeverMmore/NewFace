// 纯逻辑：条目分类、人名提取、遮蔽、提示词组装、违规检查。不依赖酒馆，可在 node 里测试。

/** 条目内容里出现这些字样，多半是人物设定 */
const CHAR_MARKERS = /(性别|年龄|岁|外貌|外表|长相|身高|体重|三围|发色|瞳色|性格|生日|出生|口癖|口头禅|喜好|爱好|职业|身份|种族|称号|gender|age|appearance|personality|height|hair|eyes)\s*[:：]?/gi;
/** 条目标题里出现这些字样，多半是设定（地点/组织/规则…） */
const SETTING_TITLE = /(世界|设定|规则|地图|地点|城市|国家|王国|帝国|学院|学校|组织|势力|门派|宗门|公司|种族|历史|年表|魔法|体系|货币|物品|道具|装备|技能|事件|背景|概述|总览|简介|风俗|宗教|政治|经济|科技|系统|status|world|lore|setting|location|faction|rule|item|history)/i;
/** 标题里出现这些字样，强烈表示人物 */
const CHAR_TITLE = /(角色|人物|NPC|主角|配角|反派|character|char\b|person)/i;

/** 不当作人名的常见关键词 */
const STOP_WORDS = new Set(['角色', '人物', '主角', '配角', '反派', 'NPC', 'npc', '男主', '女主', '老师', '学生', '同学', '父亲', '母亲', '哥哥', '姐姐', '妹妹', '弟弟', '少女', '少年', '男人', '女人', '大人', '小姐', '先生', '{{char}}', '{{user}}']);

/**
 * 统一条目格式（世界书 entries 或卡内嵌 character_book.entries）
 * @returns {{uid:string, book:string, title:string, keys:string[], content:string, constant:boolean, disabled:boolean, order:number}}
 */
export function normEntry(raw, book) {
    const keys = (Array.isArray(raw.key) ? raw.key : Array.isArray(raw.keys) ? raw.keys : String(raw.key || '').split(','))
        .map((k) => String(k).trim()).filter(Boolean);
    return {
        uid: `${book}::${raw.uid ?? raw.id ?? keys[0] ?? Math.random().toString(36).slice(2)}`,
        book,
        title: String(raw.comment || raw.name || keys[0] || '').trim(),
        keys,
        content: String(raw.content || ''),
        constant: !!raw.constant,
        disabled: !!(raw.disable || raw.enabled === false),
        order: Number(raw.order ?? raw.insertion_order ?? 100) || 0,
    };
}

/** 去掉标题里的分类前缀、括号，得到一个干净的名字 */
export function cleanTitle(title) {
    let s = String(title || '').trim();
    s = s.replace(/^[[【(（<《]\s*(?:角色|人物|NPC|character|char)\s*[\]】)）>》]\s*/i, '');
    s = s.replace(/^(?:角色|人物|NPC|character|char|配角|主角|反派)\s*[-—_:：·|/]\s*/i, '');
    s = s.replace(/[[【(（<《][^\]】)）>》]*[\]】)）>》]/g, '').trim();
    s = s.split(/\s*[-—|/]\s*/)[0].trim();
    return s;
}

/**
 * 启发式判断条目是不是人物
 * @returns {'character'|'setting'}
 */
export function guessKind(entry) {
    const title = entry.title || '';
    if (CHAR_TITLE.test(title)) return 'character';
    if (SETTING_TITLE.test(title)) return 'setting';
    const head = entry.content.slice(0, 800);
    const hits = new Set((head.match(CHAR_MARKERS) || []).map((m) => m.replace(/\s*[:：]$/, '').toLowerCase()));
    if (hits.size >= 2) return 'character';
    // 内容开头像 "姓名：xxx" / "Name: xxx"
    if (/^\s*(?:姓名|名字|全名|name)\s*[:：]/im.test(head)) return 'character';
    return 'setting';
}

function looksLikeName(s) {
    const t = String(s || '').trim();
    if (!t || STOP_WORDS.has(t)) return false;
    if (/^\d+$/.test(t)) return false;
    if (/[一-鿿]/.test(t)) return t.length >= 2 && t.length <= 10 && !/\s/.test(t);
    return t.length >= 2 && t.length <= 32;
}

/** 从内容里读 "姓名：xxx" */
function nameFromContent(content) {
    const m = String(content).match(/(?:姓名|名字|全名|name)\s*[:：]\s*([^\n，,。;；（(/|]{1,24})/i);
    return m ? m[1].trim() : '';
}

/** 人物条目 → 名字 + 别名 */
export function namesOfEntry(entry) {
    const out = [];
    const push = (s) => {
        const t = String(s || '').trim();
        if (looksLikeName(t) && !out.includes(t)) out.push(t);
    };
    push(nameFromContent(entry.content));
    push(cleanTitle(entry.title));
    for (const k of entry.keys) push(k);
    return out;
}

/** 一句话身份简介（只给名单用，不给全文） */
export function shortBio(entry, max = 60) {
    const m = entry.content.match(/(?:身份|职业|定位|role|occupation)\s*[:：]\s*([^\n]{1,80})/i);
    let s = m ? m[1] : entry.content.replace(/\s+/g, ' ');
    s = s.trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把文本里的已有人名替换成占位符，避免 AI 从设定资料里"捡"人 */
export function maskNames(text, names, placeholder = '〔某已有人物〕') {
    const list = [...new Set(names)].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);
    if (!list.length) return text;
    const re = new RegExp(list.map(escapeRe).join('|'), 'g');
    return String(text).replace(re, placeholder);
}

/**
 * 解析"禁用名单"文本：每行一个人物，"名字|别名|别名"
 * @returns {string[][]}
 */
export function parseNameList(text) {
    return String(text || '').split(/\r?\n/)
        .map((line) => line.split(/[|｜,，、]/).map((s) => s.trim()).filter(Boolean))
        .filter((g) => g.length);
}

export function formatNameList(groups) {
    return groups.map((g) => g.join(' | ')).join('\n');
}

/** 模板占位用的名字（AI 有时会原样照抄），不能当成真实姓名 */
const PLACEHOLDER_NAME = /^(?:角色姓名|角色名|新角色姓名|新角色|姓名|名字|name)$/i;
const OPEN_TAG_LINE = /^[ \t]*<([^/<>\n]{1,30})>[ \t]*$/;
const CLOSE_TAG_LINE = /^[ \t]*<\/([^<>\n]{1,30})>[ \t]*$/;
const TAG_LINE = /^\s*<\/?[^<>\n]{1,30}>\s*$/;
/** 基础资料的大标题（可带 markdown、编号、限定语、值）：NSFW 块里出现说明 AI 又抄了一遍基础资料，或者自己加了一段「二次解释」 */
const SECTION_LINE = /^[ \t#*>•-]*(?:\d+[.、)]\s*)?[*【[]*(?:NSFW\s*)?(?:基本信息|外貌特征|背景设定|关系设定|性格架构|二次解释)/i;
/** NSFW 标题行：可带 markdown / 括号 / 空格（「女性 NSFW 设定」），冒号可有可无，冒号后可带值 */
const NSFW_HEADER = /^[ \t#*>【[（(]*(?:[男女]性\s*)?NSFW\s*设定[ \t*】\]）)]*(?:[:：].*)?$/i;
/** 字段行：短标签 + 冒号（标签前可带 markdown、列表符号、编号） */
const KEY_LINE = /^[ \t#*>•-]*(?:\d+[.、)]\s*)?\**[^\s:：，。！？,.!?*#>][^:：，。！？,.!?\n]{0,23}?\**[ \t]*[:：]/;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.、)])(?:\s|$)/;
/** 分隔线 --- / *** / * * * / ___ */
const RULE_LINE = /^\s*(?:[-*_—]\s*){3,}$/;
/** 明确的备注 / 免责声明（不管在哪一行出现都算块结束） */
const NOTE_LINE = /^[ \t#*>•（(【[-]*(?:注|备注|注意|说明|提示|补充|声明|免责声明|ps|p\.s\.?|note|notes)[ \t*]*[:：]|所有角色|角色均|以上内容|本设定|纯属虚构|仅供参考|all characters|fictional/i;
/** 块后面的客套话开头 */
const CHATTER_START = /^[ \t#*>•（(【[-]*(?:以上|希望|如需|如果需要|如有需要|需要调整|祝|enjoy|hope)/i;
/** 看起来是 AI 附加说明的段落标题 */
const APPENDIX_LABEL = /说明|思路|原因|设计|备注|注释|解析|总结|分析|以下|以上|完整|合并|补充|提示|note|design|summary|explanation/i;

const indentOf = (l) => l.match(/^ */)[0].length;
/** 行首的制表符换成空格（一个制表符算一级缩进，即 2 格，和模板一致） */
const expandTabs = (l) => l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, '  '));
/** 字段行的标签（去掉 markdown、列表符号、编号和冒号后面的部分） */
const labelOf = (l) => l.trim()
    .replace(/^[#*>•\-\s]+/, '')
    .replace(/^\d+[.、)]\s*/, '')
    .replace(/^\*+/, '')
    .replace(/[ \t*]*[:：][\s\S]*$/, '')
    .replace(/\*+$/, '')
    .trim();
/** 字段行冒号后面的值（去掉 markdown 收尾） */
const valueOf = (l) => {
    const m = l.match(/[:：]([\s\S]*)$/);
    return m ? m[1].replace(/^[ \t*]+|[ \t*]+$/g, '') : '';
};
const NSFW_LABEL = (l) => labelOf(l).replace(/[【】[\]（）()]/g, '').replace(/\s+/g, '');

/** 资料的顶层字段名（如 基本信息 / 外貌特征 / 用户自定义的大标题），合并时用来识别 NSFW 块里重复抄写的基础资料 */
export function topLevelKeys(text) {
    const lines = extractTagged(text).split('\n').filter((l) => l.trim() && !TAG_LINE.test(l));
    if (!lines.length) return [];
    const top = Math.min(...lines.map(indentOf));
    return [...new Set(lines.filter((l) => indentOf(l) === top && /[:：]/.test(l)).map(labelOf).filter(Boolean))];
}

/** 「姓名:」字段的值（分隔符不跨行，字段为空时返回空串） */
function fieldName(text) {
    const m = String(text).match(/(?:^|\n)[ \t#*>-]*(?:姓名|名字|全名|Name)[ \t*]*[:：][ \t*]*([^\n*（(]{1,30})/i);
    return m ? m[1].trim().replace(/[。.，,；;]+$/, '') : '';
}

/** 包裹标签 <姓名> 里的名字（跳过模板占位名） */
function tagName(text) {
    const line = cleanOutput(text).split('\n').find((l) => OPEN_TAG_LINE.test(l));
    const n = line ? line.match(OPEN_TAG_LINE)[1].trim() : '';
    return n && !PLACEHOLDER_NAME.test(n) ? n : '';
}

/** 从生成结果里读出新角色的名字：先看「姓名:」字段，没有再看 <姓名> 标签 */
export function parseNewName(text) {
    return fieldName(text) || tagName(text);
}

/** 从资料里读性别：'male' | 'female' | ''（取「性别:」同一行里先出现的 男/女） */
export function genderOf(text) {
    const m = String(text || '').match(/(?:^|\n)[ \t#*>-]*性别[ \t*]*[:：][ \t*]*([^\n]{1,12})/);
    const g = m && m[1].match(/[男女]/);
    return !g ? '' : g[0] === '女' ? 'female' : 'male';
}

/** 只去掉首尾的空行（保留第一行的缩进，缩进层级要靠它） */
function trimBlankLines(text) {
    return String(text).replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '').replace(/^[ \t]+$/, '');
}

/** 去掉代码块标记、行尾空格和首尾空行 */
export function cleanOutput(text) {
    return trimBlankLines(String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/^[ \t]*```[\w-]*[ \t]*$/gm, '')
        .replace(/[ \t]+$/gm, ''));
}

/** 只保留 <姓名> … </姓名> 这一段，去掉 AI 在前后说的话；没有标签时原样返回 */
export function extractTagged(text) {
    const lines = cleanOutput(text).split('\n');
    const open = lines.findIndex((l) => OPEN_TAG_LINE.test(l));
    if (open < 0) return lines.join('\n');
    let close = lines.length - 1;
    while (close > open && !CLOSE_TAG_LINE.test(lines[close])) close--;
    return lines.slice(open, close > open ? close + 1 : lines.length).join('\n');
}

/** 把整段文字的最小缩进调整为 target 个空格 */
export function reindent(text, target) {
    const lines = String(text).split('\n');
    const indents = lines.filter((l) => l.trim()).map(indentOf);
    if (!indents.length) return text;
    const shift = target - Math.min(...indents);
    if (!shift) return text;
    return lines.map((l) => (!l.trim() ? l : shift > 0 ? ' '.repeat(shift) + l : l.slice(-shift))).join('\n');
}

/**
 * 从 NSFW 模板里读出结构：sections = 段落标题（身体细节 / 性经验与偏好 …），fields = 模板里出现过的所有字段名
 * @param {string[]} templates
 */
export function nsfwStructure(templates = [DEFAULT_NSFW_FEMALE, DEFAULT_NSFW_MALE]) {
    const sections = new Set();
    const fields = new Set();
    for (const t of templates) {
        const ls = String(t || '').split('\n').map(expandTabs).filter((l) => l.trim());
        const hi = ls.findIndex((l) => NSFW_HEADER.test(l));
        if (hi < 0) continue;
        const h = indentOf(ls[hi]);
        const body = ls.slice(hi + 1).filter((l) => indentOf(l) > h && KEY_LINE.test(l) && !LIST_ITEM.test(l));
        if (!body.length) continue;
        const sec = Math.min(...body.map(indentOf));
        for (const l of body) {
            const lab = labelOf(l);
            fields.add(lab);
            if (indentOf(l) === sec) sections.add(lab);
        }
    }
    return { sections, fields };
}

const DEFAULT_STRUCTURE = { sections: null, fields: null };

/**
 * 规整 NSFW 块，结果是：标题行（base 格）→ 段落标题（base+2）→ 段落内容（base+4，保留内容内部的相对层级）。
 *
 * 以模板为锚：模板里的段落标题（身体细节 / 性经验与偏好 …）无论写在哪一级缩进、带不带编号和 markdown，都当作段落开头；
 * 不靠整段缩进推层级——酒馆可能 trim 掉标题行的缩进，AI 也可能把段落写成和标题同级，或者整块平铺。
 * 块在这些地方结束：又一个 NSFW 标题（重复输出）、包裹标签、分隔线、基础资料的大标题（又抄了一遍）、
 * 备注 / 免责声明、像附加说明的未知段落标题、空行后面的客套话。
 *
 * @param {string} text
 * @param {number} base 标题行缩进
 * @param {{stopKeys?:string[], templates?:string[], header?:string}|string[]} opts
 *   stopKeys：基础资料的顶层字段名；templates：当前使用的 NSFW 模板（决定段落和字段）；header：AI 漏写标题时补的标题名
 */
export function normalizeNsfw(text, base = 2, opts = {}) {
    if (Array.isArray(opts)) opts = { stopKeys: opts };
    const { stopKeys = [], templates, header = '' } = opts;
    let structure = DEFAULT_STRUCTURE;
    if (templates) structure = nsfwStructure([...templates, DEFAULT_NSFW_FEMALE, DEFAULT_NSFW_MALE]);
    else if (!DEFAULT_STRUCTURE.sections) Object.assign(DEFAULT_STRUCTURE, nsfwStructure());
    const { sections, fields } = structure;
    const stop = new Set(stopKeys);
    const isKey = (l) => KEY_LINE.test(l);
    const isSection = (l) => isKey(l) && sections.has(labelOf(l));

    const lines = cleanOutput(text).split('\n').map(expandTabs);
    // 找标题：连续几个标题行（中间只有空行，如「**女性NSFW设定**：」后面再接「女性NSFW设定:」）取最后一个
    let start = lines.findIndex((l) => NSFW_HEADER.test(l));
    if (start >= 0) {
        for (let j = start + 1; j < lines.length; j++) {
            if (!lines[j].trim()) continue;
            if (NSFW_HEADER.test(lines[j]) && !valueOf(lines[start])) start = j;
            else break;
        }
    }
    let headLabel;
    let headValue = '';
    let body;
    let h;
    if (start >= 0) {
        headLabel = NSFW_LABEL(lines[start]);
        headValue = valueOf(lines[start]);
        h = indentOf(lines[start]);
        body = lines.slice(start + 1);
    } else {
        // AI 漏写了标题：从第一个段落标题开始，补上标题
        const first = lines.findIndex(isSection);
        if (first < 0 || !header) return reindent(trimBlankLines(lines.filter((l) => !TAG_LINE.test(l)).join('\n')), base);
        headLabel = header;
        h = -1;
        body = lines.slice(first);
    }

    const pre = []; // 第一个段落标题之前的内容（AI 没写段落标题、直接写字段时）
    const secs = []; // {key, value, indent, lines}
    let nested = false; // 是否有正常的层级（内容比段落标题深）
    const sectionIndent = () => (secs.length ? secs[secs.length - 1].indent : h + 2);
    const nextNonBlank = (i) => body.slice(i + 1).find((x) => x.trim()) || '';
    const isStopLine = (l) => NSFW_HEADER.test(l) || OPEN_TAG_LINE.test(l) || RULE_LINE.test(l) || SECTION_LINE.test(l) || NOTE_LINE.test(l);

    for (let i = 0; i < body.length; i++) {
        const l = body[i];
        const cur = secs[secs.length - 1];
        const target = cur ? cur.lines : pre;
        if (!l.trim()) {
            target.push(l);
            continue;
        }
        if (CLOSE_TAG_LINE.test(l)) continue;
        // 标题下面、还没有任何内容时的免责声明 / 分隔线（「（以下设定中角色均已成年）」）：跳过；有内容之后再出现就是块结束
        if (!cur && !pre.some((x) => x.trim()) && (NOTE_LINE.test(l) || RULE_LINE.test(l))) continue;
        if (isStopLine(l)) break;
        const ind = indentOf(l);
        const lab = isKey(l) ? labelOf(l) : '';
        if (lab && sections.has(lab)) {
            secs.push({ key: lab, value: valueOf(l), indent: ind, lines: [] });
            continue;
        }
        if (lab && stop.has(lab) && !fields.has(lab)) break; // 基础资料里的自定义大标题：又抄了一遍
        const prev = [...target].reverse().find((x) => x.trim());
        const prevBlank = target.length > 0 && !target[target.length - 1].trim();
        // 比标题还浅（或同级）的非段落行：只在有层级的写法里才能判断，平铺写法里它们就是内容
        if (h >= 0 && ind <= h && h < sectionIndent() && !LIST_ITEM.test(l)) break;
        if (!cur) {
            // 段落标题之前：字段和列表留下，散文（多半是「（以下角色均已成年）」之类）丢掉
            if (lab || LIST_ITEM.test(l)) pre.push(l);
            continue;
        }
        const shallow = ind <= cur.indent;
        if (shallow && lab && !fields.has(lab)) {
            // 段落这一级出现模板里没有的标题：像附加说明、后面紧跟停止行、或有层级时隔着空行出现，都算块结束
            const next = nextNonBlank(i);
            if (/[*#]/.test(l.trim()[0]) || /\*\*/.test(l) || APPENDIX_LABEL.test(lab) || !next || isStopLine(next) || (prevBlank && nested)) break;
        }
        if (shallow && !lab && !LIST_ITEM.test(l)) {
            // 段落这一级的散文：空行后面的是客套话；紧跟在列表后面、像客套话开头的也是
            if (prevBlank || (prev && LIST_ITEM.test(prev) && CHATTER_START.test(l))) break;
        }
        if (LIST_ITEM.test(l) && prevBlank) {
            // 空行后面、比这一段已有列表项更浅的列表项：多半是块后面的附注
            const items = cur.lines.filter((x) => x.trim() && LIST_ITEM.test(x));
            if (items.length && ind < Math.min(...items.map(indentOf))) break;
        }
        if (ind > cur.indent) nested = true;
        cur.lines.push(l);
    }

    const pad = (n) => ' '.repeat(n);
    const out = [`${pad(base)}${headLabel}:${headValue ? ` ${headValue}` : ''}`];
    const preText = trimBlankLines(pre.join('\n'));
    if (preText) out.push(reindent(preText, base + 2));
    for (const s of secs) {
        out.push(`${pad(base + 2)}${s.key}:${s.value ? ` ${s.value}` : ''}`);
        const content = trimBlankLines(s.lines.join('\n'));
        if (content) out.push(reindent(content, base + 4));
    }
    return out.join('\n');
}

/**
 * 合并 SFW 与 NSFW：NSFW 块插在「背景设定:」前面（即外貌特征之后），与其他大标题同级；整份资料用 <姓名> 标签包裹
 * @param {{templates?:string[]}} opts templates：当前使用的 NSFW 模板（用户可能自定义了段落）
 */
export function mergeProfile(sfw, nsfw, opts = {}) {
    let s = extractTagged(sfw);
    const header = (g) => (g === 'male' ? '男性NSFW设定' : g === 'female' ? '女性NSFW设定' : 'NSFW设定');
    if (!s) return nsfw ? normalizeNsfw(nsfw, 2, { templates: opts.templates, header: header('') }) : '';
    const name = parseNewName(s) || '新角色';
    let lines = s.split('\n');
    const open = lines[0].match(OPEN_TAG_LINE);
    if (!open) {
        lines = [`<${name}>`, ...reindent(s, 2).split('\n'), `</${name}>`];
    } else {
        // 标签是模板占位名（如 <角色姓名>）时换成真实姓名；缺结束标签时补上
        const tag = PLACEHOLDER_NAME.test(open[1].trim()) && name !== '新角色' ? name : open[1].trim();
        lines[0] = `<${tag}>`;
        if (CLOSE_TAG_LINE.test(lines[lines.length - 1])) lines[lines.length - 1] = `</${tag}>`;
        else lines.push(`</${tag}>`);
    }
    const n0 = nsfw ? cleanOutput(nsfw) : '';
    if (!n0) return lines.join('\n');
    let at = lines.findIndex((l) => /^\s*背景设定\s*[:：]/.test(l));
    const content = lines.slice(1, -1).filter((l) => l.trim());
    const base = at >= 0 ? indentOf(lines[at]) : content.length ? Math.min(...content.map(indentOf)) : 2;
    if (at < 0) at = lines.length - 1; // 没有背景设定就插在结束标签前
    const before = lines.slice(0, at);
    while (before.length > 1 && !before[before.length - 1].trim()) before.pop();
    const block = normalizeNsfw(n0, base, { stopKeys: topLevelKeys(s), templates: opts.templates, header: header(genderOf(s)) });
    return [...before, '', block, '', ...lines.slice(at)].join('\n');
}

/**
 * 检查生成结果
 * @param {string} text 生成结果
 * @param {string[][]} forbidden 不许出现的人物（每组是 名字+别名）
 * @param {string[][]} allIdentities 所有已有人物（含允许提及的、{{char}}、{{user}}）——新角色不能和他们重名
 * @returns {{mentions:{name:string,count:number}[], nameClash:string, clashName:string, newName:string}}
 */
export function checkOutput(text, forbidden, allIdentities = []) {
    const t = String(text || '');
    const mentions = [];
    for (const group of forbidden) {
        let count = 0;
        let hitName = '';
        for (const n of group) {
            if (n.length < 2) continue;
            const c = t.split(n).length - 1;
            if (c > count) {
                count = c;
                hitName = n;
            }
        }
        if (count) mentions.push({ name: hitName === group[0] ? group[0] : `${group[0]}（${hitName}）`, count });
    }
    const newName = parseNewName(t);
    let nameClash = '';
    let clashName = '';
    // 「姓名:」字段和 <姓名> 标签都要查：修正时 AI 可能只改了其中一处
    for (const nm of [...new Set([fieldName(t), tagName(t)].filter((x) => x.length >= 2))]) {
        const group = [...forbidden, ...allIdentities].find((g) => g.some((n) => n.length >= 2 && (nm === n || nm.includes(n) || n.includes(nm))));
        if (group) {
            nameClash = group[0];
            clashName = nm;
            break;
        }
    }
    return { mentions, nameClash, clashName, newName };
}

export function hasViolation(check) {
    return !!(check.mentions.length || check.nameClash);
}

export function violationText(check) {
    const bits = [];
    if (check.nameClash) bits.push(`新角色的名字「${check.clashName || check.newName}」与已有人物「${check.nameClash}」重名或过于相似，必须换一个全新的名字`);
    if (check.mentions.length) bits.push(`出现了不允许的已有人物：${check.mentions.map((m) => `${m.name}×${m.count}`).join('、')}。必须删掉这些人物，相关的关系/经历改成与新创造的无名路人、或与允许提及的人物相关`);
    return bits.join('；');
}

// ---------------- 提示词 ----------------

/** 模板版本：模板结构改动时 +1，见 migrateTemplates */
export const TEMPLATE_VERSION = 3;

/** 短指纹，用来判断用户有没有改过旧版默认模板（不用把旧模板全文留在代码里） */
export function textHash(s) {
    let x = 5381;
    for (const c of String(s)) x = ((x * 33) ^ c.codePointAt(0)) >>> 0;
    return x.toString(36);
}

/** v0.2.0（模板版本 2）默认 NSFW 模板的指纹 */
const V2_NSFW_HASH = { nsfwFemale: 'mrwjzd', nsfwMale: 'ah8ihm' };

/**
 * 把旧版本保存的模板升级到当前版本（直接修改 s）
 * - 版本 1（v0.1.0）：模板结构完全不同，全部换成新默认值，旧模板备份到 templateBackupV1
 * - 版本 2（v0.2.0）：NSFW 模板加回性经验等字段；用户没改过的直接换，改过的保留不动
 * @returns {{changed:boolean, fromVersion:number, kept:string[]}} kept：因为用户改过而没替换的模板键名
 */
export function migrateTemplates(s) {
    const from = Number(s.templateVersion) || 1;
    const kept = [];
    if (from >= TEMPLATE_VERSION) return { changed: false, fromVersion: from, kept };
    const defaults = { nsfwFemale: DEFAULT_NSFW_FEMALE, nsfwMale: DEFAULT_NSFW_MALE };
    if (from < 2) {
        // 新安装时 sfwFields 已经是默认值、也没有 nsfwFields，不用备份
        if (s.nsfwFields !== undefined || (s.sfwFields && s.sfwFields !== DEFAULT_SFW_FIELDS)) {
            s.templateBackupV1 = { sfwFields: s.sfwFields, nsfwFields: s.nsfwFields };
        }
        s.sfwFields = DEFAULT_SFW_FIELDS;
        delete s.nsfwFields;
        Object.assign(s, defaults);
    } else {
        for (const [k, v] of Object.entries(defaults)) {
            if (s[k] === undefined || textHash(s[k]) === V2_NSFW_HASH[k]) s[k] = v;
            else if (s[k] !== v) kept.push(k);
        }
    }
    s.templateVersion = TEMPLATE_VERSION;
    return { changed: true, fromVersion: from, kept };
}

// 模板里：（…）是填写说明，输出时删掉；<…> 是要换成实际内容的小标题
export const DEFAULT_SFW_FIELDS = `<角色姓名>
  基本信息:
    姓名:
    年龄: （具体数字+岁，必须成年）
    性别:
    身份: （多重身份用 / 分隔，体现在这个世界里的社会位置）
    与{{user}}关系: （一句话说清两人现在是什么关系）

  外貌特征:
    形象概述: （一句话：脸 + 气质给人的第一印象）
    身高:
    体重:
    三围: （女性写成 B88(D) - W58 - H86 的格式；男性写胸围-腰围-臀围）
    体型描述:
    罩杯: （仅女性）
    脸型:
    肤色:
    眼睛特征:
    鼻子特征:
    嘴唇特征:
    发型:

  背景设定:
    <经历小标题，如：成名轨迹 / 出身经历>:
      - （按时间顺序的关键经历，写清年龄节点，以及这段经历让角色养成了什么性子）
      -
    <当前处境小标题，如：来到此地的始末>:
      - （角色是怎么进入当前故事舞台的，必须符合世界观资料）
      -

  关系设定:
    互动起点:
      - （一开始怎么看待{{user}}，凭什么决定态度）
    互动机制:
      - （{{user}}做到什么，角色会更信任、更顺从）
      - （{{user}}做了什么，角色会立刻冷下来）

  性格架构:
    底层认知-防备机制:
      <特质名，4~10 字，如：看重本事与讨厌平庸>:
        内在信念: （这种性格背后的信念与成因）
        行为表现:
          - （放进当前世界与处境里的具体行为：有动作、有物件、有细节）
          -
          -
    显性性格-日常做派:
      <特质名>:
        内在信念:
        行为表现:
          -
          -
          -
    应激反差-受挫状态:
      <特质名>:
        内在信念: （压力、受挫或有求于人时露出的另一面）
        行为表现:
          -
          -
          -

  二次解释:
    关于“<最容易被演歪的一个特质>”:
      - （划清边界：角色会怎样、绝不会怎样，防止扮演时演过头或演成别的性格）
      -
    关于“<另一个容易误读的特质>”:
      -
      -
    关于“<外貌与身段的自我认知>”:
      -
      -
</角色姓名>`;

export const DEFAULT_NSFW_FEMALE = `  女性NSFW设定:
    身体细节:
      奶子:
        大小与形状: （与外貌特征里的罩杯一致）
        乳头与乳晕: （颜色、大小、形状）
      性器:
        阴唇: （颜色、形状、闭合程度）
        阴蒂: （大小、颜色、受刺激时的反应）
        阴道: （内部构造与插入时的独特触感，要有让人记住的特点）
        屁眼: （颜色，以及内部构造与触感的独特之处）
      屁股:
        形状:
        大小: （包括走动、受压时的样子）
    性经验与偏好:
      性取向:
      性经验: （有没有过、和什么样的人、留下了什么印象；要与背景经历对得上）
      性观念: （怎么看待性，和日常人设是一致还是反差）
      敏感带: （具体部位，以及被碰到时身体和表情的反应）
      性癖: （具体的偏好，要能从性格和经历里找到来由）
      雷区与底线: （绝对不接受的事，碰到时会怎么反应）
      自慰习惯: （频率、方式、会想着什么）
      性幻想:
    亲密时的反差:
      - （亲密时与日常性格不一样的地方，写具体的语气、动作、表情）
      -
    发展亲密关系的契机:
      - （在什么情境下、因为{{user}}做了什么，才可能和{{user}}走到这一步）
      - `;

export const DEFAULT_NSFW_MALE = `  男性NSFW设定:
    身体细节:
      胸腹:
        胸肌与腹肌: （形状、线条、结实程度）
        乳头: （颜色、大小）
      性器:
        阴茎: （长度、粗细、形状、颜色、勃起前后的差别）
        龟头: （形状、颜色、敏感程度）
        阴囊: （大小、形态）
        屁眼: （颜色，以及内部构造与触感的独特之处）
      屁股:
        形状:
        大小:
    性经验与偏好:
      性取向:
      性经验: （有没有过、和什么样的人、留下了什么印象；要与背景经历对得上）
      性观念: （怎么看待性，和日常人设是一致还是反差）
      敏感带: （具体部位，以及被碰到时身体和表情的反应）
      性癖: （具体的偏好，要能从性格和经历里找到来由）
      雷区与底线: （绝对不接受的事，碰到时会怎么反应）
      自慰习惯: （频率、方式、会想着什么）
      性幻想:
    亲密时的反差:
      - （亲密时与日常性格不一样的地方，写具体的语气、动作、表情）
      -
    发展亲密关系的契机:
      - （在什么情境下、因为{{user}}做了什么，才可能和{{user}}走到这一步）
      - `;

export const DEFAULT_SYSTEM = `你是一名专业的角色设定作者，负责在一个已有的世界观里创造【全新的原创角色】。

铁律（违反任何一条都视为失败）：
1. 新角色必须是一个此前从未存在过的、全新的人物。绝对不能直接使用、改名套用、合并、或"其实就是"【已有人物名单】里的任何人。
2. 新角色的姓名不能与名单中的任何名字相同、相近或共用全名。
3. 资料里禁止出现名单上的人物（"允许提及的已有人物"和 {{char}}、{{user}} 除外）。需要写到亲友、师长、对手时，就当场创造新的、次要的无名或新名人物，不要从名单里借人。
4. 新角色的身份定位尽量不要与名单里已有人物重复，要给这个世界补上一块新的拼图。
5. 新角色必须符合世界观资料里的设定（地理、势力、规则、时代、科技/魔法水平）。
6. 所有角色均为成年人（18 岁及以上），年龄必须写明具体数字。
7. 严格按照给定的结构和缩进输出，直接输出资料正文，不要开场白、不要解释、不要总结，不要用代码块包裹。`;

/**
 * 组装 SFW 生成提示词
 * @param {object} p
 * @param {string} p.world 设定资料（已遮蔽）
 * @param {{names:string[], bio:string}[]} p.roster 已有人物名单
 * @param {{names:string[], content:string}[]} p.allowed 允许提及的已有人物（附完整资料）
 * @param {string} p.charName
 * @param {string} p.userName
 * @param {string} p.charCard 当前角色卡设定（可空）
 * @param {string} p.request 用户需求
 * @param {string} p.fields 字段模板
 */
export function buildSfwPrompt(p) {
    const parts = [];
    if (p.world) parts.push(`# 世界观资料\n（文中的"〔某已有人物〕"是已存在的人物，已隐去名字，不要使用或猜测他们）\n\n${p.world}`);
    if (p.charCard) parts.push(`# 当前主角 {{char}}（${p.charName}）的设定\n\n${p.charCard}`);
    const rosterLines = p.roster.map((r) => `- ${r.names.join(' / ')}${r.bio ? `：${r.bio}` : ''}`);
    rosterLines.push(`- ${p.charName}（{{char}}，主角）`);
    if (p.userName) rosterLines.push(`- ${p.userName}（{{user}}，玩家）`);
    parts.push(`# 已有人物名单（新角色不能是其中任何一人，也不能和他们重名）\n\n${rosterLines.join('\n')}`);
    if (p.allowed.length) {
        parts.push(`# 允许提及的已有人物（新角色可以和他们有关系，但新角色本人不是他们）\n\n${p.allowed.map((a) => `## ${a.names.join(' / ')}\n${a.content}`).join('\n\n')}`);
    } else {
        parts.push('# 允许提及的已有人物\n\n（无。除了 {{char}} 和 {{user}}，资料里不要出现名单上的任何人）');
    }
    parts.push(`# 用户想要的新角色\n\n${p.request || '（没有特别要求，请自由发挥，创造一个能丰富这个世界的新角色）'}`);
    parts.push(`# 输出格式

严格按照下面的结构输出：
- YAML 风格，两个空格一级缩进，整份资料用 <姓名> 和 </姓名> 标签包起来（换成新角色的真实姓名）。
- （…）里是填写说明，输出时删掉；<…> 形式的小标题换成你自己起的具体名字；列表条数可以按需增减。
- 写法：短句、具体、有画面感。行为表现要放进这个世界和角色当前的处境里，写出具体动作、物件和细节，不要堆砌空泛的形容词。
- 这一份只写基础资料，不要写 NSFW 内容（另外生成）。

${p.fields}`);
    parts.push('再次提醒：这是一个全新的原创人物。写之前先在心里确认名字和身份都不在【已有人物名单】里。');
    return parts.join('\n\n---\n\n');
}

export function buildNsfwPrompt(p) {
    const parts = [];
    if (p.world) parts.push(`# 世界观资料（参考）\n\n${p.world}`);
    parts.push(`# 已有人物名单（不要在资料里提到他们，{{char}}、{{user}} 和允许提及的人物除外）\n\n${p.roster.map((r) => `- ${r.names.join(' / ')}`).join('\n') || '（无）'}`);
    if (p.allowed.length) parts.push(`# 允许提及的已有人物\n\n${p.allowed.map((a) => `- ${a.names.join(' / ')}`).join('\n')}`);
    parts.push(`# 这个新角色的基础资料（已确定，以此为准）\n\n${p.sfw}`);
    if (p.request) parts.push(`# 用户的额外要求\n\n${p.request}`);
    // 用户自己改过的旧模板里可能没有这些字段，提示词不能要求模板里没有的东西
    const personal = /性经验|性观念|性癖|反差/.test(p.fields);
    parts.push(`# 任务

为上面这个新角色补写成人向（NSFW）设定，只写下面模板里列出的字段。必须与基础资料保持一致：身体细节对上年龄、外貌、罩杯/身材${personal ? '；性经验、性观念、性癖、亲密时的反差这类内容要从角色的性格架构和背景经历里推出来' : ''}。不要改动已确定的设定。角色是成年人。

只输出下面这一块，它会被插到基础资料的「外貌特征」后面：
- YAML 风格，两个空格一级缩进，从「NSFW设定:」那一行开始写；不要重复基础资料，不要用 <姓名> 标签包裹，不要用代码块，最后不要加备注或说明。
- （…）里是填写说明，输出时删掉；列表条数可以按需增减。
- 写法：具体、直白、有个人特色。每个部位都要有让人记住的独特之处${personal ? '；性癖和反差要贴合这个人，不要写成谁都能用的套路' : ''}。

${p.fields}`);
    return parts.join('\n\n---\n\n');
}

export function buildRepairPrompt(original, check) {
    return `下面这份角色资料不合格：${violationText(check)}。\n\n请在保持其余设定不变的前提下修改，输出修改后的完整资料（保持原来的结构和缩进，不要解释）：\n\n${original}`;
}

/** 按字数预算拼接设定资料：常驻条目优先，再按 order */
export function joinWorld(entries, maxChars) {
    const sorted = [...entries].sort((a, b) => (b.constant - a.constant) || (a.order - b.order));
    const out = [];
    let used = 0;
    for (const e of sorted) {
        const block = `## ${e.title || e.keys[0] || '条目'}\n${e.content.trim()}`;
        if (used + block.length > maxChars) {
            const left = maxChars - used;
            if (left > 200) out.push(`${block.slice(0, left)}…`);
            break;
        }
        out.push(block);
        used += block.length + 2;
    }
    return out.join('\n\n');
}
