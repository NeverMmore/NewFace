// 与酒馆交互：读当前角色绑定的世界书、调用 LLM、写回世界书 / 新建角色卡

import { normEntry } from './core.js';

export const EXT = 'newface';

export function ctx() {
    const c = globalThis.SillyTavern?.getContext?.();
    if (!c) throw new Error('无法访问 SillyTavern 上下文');
    return c;
}

function headers(omitContentType = false) {
    const h = { ...ctx().getRequestHeaders() };
    if (omitContentType) delete h['Content-Type'];
    return h;
}

/** characterId 是字符串，没选中时为 undefined；注意 Number('') === 0 */
export function charIndex(c = ctx()) {
    const raw = c.characterId;
    if (raw === undefined || raw === null || raw === '') return -1;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : -1;
}

export function currentCharacter() {
    const c = ctx();
    if (c.groupId) return null;
    return c.characters?.[charIndex(c)] || null;
}

export function toast(type, msg) {
    const t = globalThis.toastr;
    if (t?.[type]) t[type](msg, 'NewFace');
    else console.log(`[NewFace] ${type}: ${msg}`);
}

export async function allWorldNames() {
    const c = ctx();
    if (typeof c.getWorldInfoNames === 'function') {
        try {
            return await c.getWorldInfoNames();
        } catch { /* fall through */ }
    }
    const res = await fetch('/api/settings/get', { method: 'POST', headers: headers(), body: JSON.stringify({}) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.world_names) ? data.world_names : [];
}

/**
 * 当前角色绑定的世界书：主世界书 + 附加世界书（charLore）+ 当前聊天绑定的世界书
 * @returns {Promise<{name:string, source:string}[]>}
 */
export async function boundWorldNames() {
    const c = ctx();
    const ch = currentCharacter();
    const out = [];
    const push = (name, source) => {
        if (name && !out.some((x) => x.name === name)) out.push({ name, source });
    };
    if (ch) {
        push(ch.data?.extensions?.world, '角色主世界书');
        try {
            const wi = await import('/scripts/world-info.js');
            const file = String(ch.avatar || '').replace(/\.[^.]+$/, '');
            const lore = wi.world_info?.charLore?.find((x) => x.name === file);
            for (const n of lore?.extraBooks || []) push(n, '角色附加世界书');
        } catch (e) {
            console.warn('[NewFace] 读取附加世界书失败', e);
        }
    }
    push(c.chatMetadata?.world_info, '聊天世界书');
    return out;
}

/** 卡内嵌的 character_book（没导入成独立世界书时也能用） */
export function embeddedBookEntries() {
    const ch = currentCharacter();
    const book = ch?.data?.character_book;
    if (!book || !Array.isArray(book.entries) || !book.entries.length) return [];
    return book.entries.map((e, i) => normEntry({ ...e, uid: e.id ?? i }, '(卡内嵌世界书)'));
}

export async function loadBookEntries(name) {
    const c = ctx();
    let data;
    if (typeof c.loadWorldInfo === 'function') data = await c.loadWorldInfo(name);
    else {
        const res = await fetch('/api/worldinfo/get', { method: 'POST', headers: headers(), body: JSON.stringify({ name }) });
        data = res.ok ? await res.json() : null;
    }
    return Object.values(data?.entries || {}).map((e) => normEntry(e, name));
}

export function cardText(maxChars = 3000) {
    const c = ctx();
    const ch = currentCharacter();
    if (!ch) return '';
    let f = {};
    try {
        f = c.getCharacterCardFields?.({ chid: charIndex(c) }) || {};
    } catch { /* old version */ }
    const desc = f.description ?? ch.description ?? '';
    const pers = f.personality ?? ch.personality ?? '';
    const scen = f.scenario ?? ch.scenario ?? '';
    const s = [desc, pers && `性格：${pers}`, scen && `场景：${scen}`].filter(Boolean).join('\n\n');
    return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

// ---------------- LLM ----------------

/** 去掉思考过程；只去首尾空行和末尾空白，不动第一行的缩进（YAML 缩进层级要靠它） */
function stripThinking(t) {
    return String(t || '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

/**
 * @param {{system:string, prompt:string, settings:object, signal?:AbortSignal}} p
 */
export async function callLLM({ system, prompt, settings, signal }) {
    const c = ctx();
    const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
    if (settings.apiMode === 'profile') {
        const svc = c.ConnectionManagerRequestService;
        if (!svc) throw new Error('当前酒馆不支持连接配置档（需要启用 Connection Manager）');
        if (!settings.profileId) throw new Error('请先在 NewFace 设置里选择连接配置档');
        const res = await svc.sendRequest(settings.profileId, messages, Number(settings.maxTokens) || 4096, {
            stream: false, signal, extractData: true, includePreset: true, includeInstruct: true,
        });
        return stripThinking(typeof res === 'string' ? res : res?.content);
    }
    if (typeof c.generateRaw !== 'function') throw new Error('无法访问酒馆 generateRaw');
    const onAbort = () => {
        try {
            c.stopGeneration?.();
        } catch { /* ignore */ }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        let res;
        try {
            res = await c.generateRaw({ prompt: messages });
        } catch (e) {
            // 旧版酒馆：位置参数
            if (/is not a function|prompt\.map|Cannot read/i.test(String(e?.message))) res = await c.generateRaw(prompt, null, false, false, system);
            else throw e;
        }
        if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
        return stripThinking(res);
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

export function connectionProfiles() {
    try {
        return ctx().extensionSettings?.connectionManager?.profiles || [];
    } catch {
        return [];
    }
}

// ---------------- 写回 ----------------

/** 把新角色写成目标世界书里的一个新条目（默认关键词触发，不常驻） */
export async function addWorldEntry(bookName, { name, keys, content }) {
    const c = ctx();
    const data = (await c.loadWorldInfo?.(bookName)) || { entries: {} };
    if (!data.entries) data.entries = {};
    const uids = Object.values(data.entries).map((e) => Number(e.uid)).filter(Number.isFinite);
    const uid = uids.length ? Math.max(...uids) + 1 : 0;
    data.entries[uid] = {
        uid,
        key: keys,
        keysecondary: [],
        comment: name,
        content,
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: null,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        displayIndex: uid,
    };
    await c.saveWorldInfo(bookName, data, true);
    try {
        // 世界书编辑器正打开这本书时刷新显示
        await c.reloadWorldInfoEditor?.(bookName);
    } catch { /* ignore */ }
    return uid;
}

/** 新建一张角色卡（JSON 导入），绑定同一本世界书 */
export async function createCharacterCard({ name, description, worldName }) {
    const c = ctx();
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description,
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '由 NewFace 根据世界书生成',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: ['NewFace'],
            creator: '',
            character_version: '',
            extensions: { world: worldName || '', talkativeness: '0.5', fav: false, depth_prompt: { prompt: '', depth: 4, role: 'system' } },
        },
    };
    Object.assign(card, { name, description, personality: '', scenario: '', first_mes: '', mes_example: '' });
    const file = new File([JSON.stringify(card)], `${name || 'NewFace'}.json`, { type: 'application/json' });
    const form = new FormData();
    form.append('avatar', file);
    form.append('file_type', 'json');
    form.append('user_name', c.name1 || 'User');
    const res = await fetch('/api/characters/import', { method: 'POST', headers: headers(true), body: form, cache: 'no-cache' });
    if (!res.ok) throw new Error(`导入角色失败：HTTP ${res.status}`);
    const data = await res.json();
    if (data?.error) throw new Error('酒馆返回导入错误');
    try {
        await c.getCharacters?.();
    } catch { /* ignore */ }
    return data.file_name;
}

// ---------------- 设置与历史 ----------------

export function saveSettings() {
    ctx().saveSettingsDebounced();
}

export function settings(defaults) {
    const c = ctx();
    const all = c.extensionSettings;
    if (!all[EXT] || typeof all[EXT] !== 'object') all[EXT] = {};
    const s = all[EXT];
    for (const [k, v] of Object.entries(defaults)) if (s[k] === undefined) s[k] = structuredClone(v);
    return s;
}
