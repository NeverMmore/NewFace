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

/** 从生成结果里读出新角色的名字 */
export function parseNewName(text) {
    const m = String(text).match(/(?:^|\n)\s*[#*\-\s]*(?:姓名|名字|全名|Name)\s*[*]*\s*[:：]\s*[*]*\s*([^\n*（(]{1,30})/i);
    return m ? m[1].trim().replace(/[。.，,；;]+$/, '') : '';
}

/**
 * 检查生成结果
 * @param {string} text 生成结果
 * @param {string[][]} forbidden 不许出现的人物（每组是 名字+别名）
 * @param {string[][]} allIdentities 所有已有人物（含允许提及的、{{char}}、{{user}}）——新角色不能和他们重名
 * @returns {{mentions:{name:string,count:number}[], nameClash:string, newName:string}}
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
    if (newName) {
        for (const group of [...forbidden, ...allIdentities]) {
            const hit = group.find((n) => n.length >= 2 && (newName === n || newName.includes(n) || (n.includes(newName) && newName.length >= 2)));
            if (hit) {
                nameClash = group[0];
                break;
            }
        }
    }
    return { mentions, nameClash, newName };
}

export function hasViolation(check) {
    return !!(check.mentions.length || check.nameClash);
}

export function violationText(check) {
    const bits = [];
    if (check.nameClash) bits.push(`新角色的名字「${check.newName}」与已有人物「${check.nameClash}」重名或过于相似，必须换一个全新的名字`);
    if (check.mentions.length) bits.push(`出现了不允许的已有人物：${check.mentions.map((m) => `${m.name}×${m.count}`).join('、')}。必须删掉这些人物，相关的关系/经历改成与新创造的无名路人、或与允许提及的人物相关`);
    return bits.join('；');
}

// ---------------- 提示词 ----------------

export const DEFAULT_SFW_FIELDS = `姓名：
性别：
年龄：（具体数字）
身份 / 职业：
外貌：（身高、体型、发型发色、瞳色、穿着、显著特征）
性格：（核心性格、表里差异、优点与缺点）
背景经历：
说话方式与口头禅：
喜好 / 厌恶：
能力 / 特长：
在这个世界中的位置：（所属势力、社会地位、日常活动范围）
与 {{char}} 的关系：
与 {{user}} 的关系：
登场契机：（适合在什么情境下第一次出场）`;

export const DEFAULT_NSFW_FIELDS = `性取向：
性经验：
性观念 / 态度：
亲密时的性格表现：（与日常的反差）
身体细节：（胸部、臀部、私处、体毛、肤质等）
敏感带：
性癖 / 偏好：
雷区 / 底线：
自慰习惯：
性幻想：
与 {{char}} / {{user}} 发展亲密关系的可能契机：`;

export const DEFAULT_SYSTEM = `你是一名专业的角色设定作者，负责在一个已有的世界观里创造【全新的原创角色】。

铁律（违反任何一条都视为失败）：
1. 新角色必须是一个此前从未存在过的、全新的人物。绝对不能直接使用、改名套用、合并、或"其实就是"【已有人物名单】里的任何人。
2. 新角色的姓名不能与名单中的任何名字相同、相近或共用全名。
3. 资料里禁止出现名单上的人物（"允许提及的已有人物"和 {{char}}、{{user}} 除外）。需要写到亲友、师长、对手时，就当场创造新的、次要的无名或新名人物，不要从名单里借人。
4. 新角色的身份定位尽量不要与名单里已有人物重复，要给这个世界补上一块新的拼图。
5. 新角色必须符合世界观资料里的设定（地理、势力、规则、时代、科技/魔法水平）。
6. 所有角色均为成年人（18 岁及以上），年龄必须写明具体数字。
7. 直接输出资料正文，不要开场白、不要解释、不要总结。`;

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
    parts.push(`# 输出格式\n\n按以下字段逐项填写，内容具体、有画面感，避免空泛套话：\n\n${p.fields}`);
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
    parts.push(`# 任务\n\n为上面这个新角色补写成人向（NSFW）资料。必须与基础资料里的性格、年龄、经历、身体特征保持一致，不要改动已确定的设定。角色是成年人。\n\n按以下字段逐项填写，具体、直白、有个人特色：\n\n${p.fields}`);
    return parts.join('\n\n---\n\n');
}

export function buildRepairPrompt(original, check) {
    return `下面这份角色资料不合格：${violationText(check)}。\n\n请在保持其余设定不变的前提下修改，输出修改后的完整资料（同样的字段格式，不要解释）：\n\n${original}`;
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
