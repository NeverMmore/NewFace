// 主对话框

import {
    DEFAULT_NSFW_FIELDS, DEFAULT_SFW_FIELDS, DEFAULT_SYSTEM,
    buildNsfwPrompt, buildRepairPrompt, buildSfwPrompt, checkOutput, formatNameList, guessKind,
    hasViolation, joinWorld, maskNames, namesOfEntry, parseNameList, parseNewName, shortBio, violationText,
} from './core.js';
import {
    addWorldEntry, allWorldNames, boundWorldNames, callLLM, cardText, connectionProfiles, createCharacterCard,
    ctx, currentCharacter, embeddedBookEntries, loadBookEntries, saveSettings, settings, toast,
} from './st.js';

export const DEFAULTS = {
    apiMode: 'tavern',
    profileId: '',
    maxTokens: 4096,
    worldBudget: 12000,
    mask: true,
    withCard: true,
    withBio: true,
    autoFix: true,
    fixTries: 2,
    mode: 'both',
    sfwFields: DEFAULT_SFW_FIELDS,
    nsfwFields: DEFAULT_NSFW_FIELDS,
    system: DEFAULT_SYSTEM,
    /** 手动改过的分类：{ [entry.uid]: 'character'|'setting'|'skip' } */
    kinds: {},
    /** 每个角色额外勾选的世界书：{ [avatar]: string[] } */
    extraBooks: {},
    history: [],
};

const HISTORY_MAX = 30;

const state = {
    s: null,
    books: [], // {name, source, on}
    entries: [], // normEntry + kind + allowed
    sfw: '',
    nsfw: '',
    busy: null, // AbortController
    root: null,
};

const $ = (sel) => state.root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function charKey() {
    return currentCharacter()?.avatar || '';
}

// ---------------- 数据 ----------------

async function loadBooks() {
    const s = state.s;
    const bound = await boundWorldNames();
    const extra = s.extraBooks[charKey()] || [];
    state.books = [
        ...bound.map((b) => ({ ...b, on: true })),
        ...extra.filter((n) => !bound.some((b) => b.name === n)).map((name) => ({ name, source: '手动添加', on: true })),
    ];
    const embedded = embeddedBookEntries();
    if (embedded.length && !bound.length) state.books.push({ name: '(卡内嵌世界书)', source: '角色卡内嵌', on: true });
    await loadEntries();
}

async function loadEntries() {
    const s = state.s;
    const list = [];
    for (const b of state.books.filter((x) => x.on)) {
        try {
            const entries = b.name === '(卡内嵌世界书)' ? embeddedBookEntries() : await loadBookEntries(b.name);
            list.push(...entries);
        } catch (e) {
            toast('warning', `读取世界书「${b.name}」失败：${e.message}`);
        }
    }
    const prevAllowed = new Set(state.entries.filter((e) => e.allowed).map((e) => e.uid));
    state.entries = list.filter((e) => e.content.trim()).map((e) => ({
        ...e,
        kind: s.kinds[e.uid] || (e.disabled ? 'skip' : guessKind(e)),
        allowed: prevAllowed.has(e.uid),
    }));
    rebuildNameList();
    renderBooks();
    renderEntries();
}

function rebuildNameList() {
    const groups = state.entries.filter((e) => e.kind === 'character').map(namesOfEntry).filter((g) => g.length);
    $('#nf-names').value = formatNameList(groups);
}

/** 汇总一次生成需要的材料 */
function material() {
    const s = state.s;
    const c = ctx();
    const chars = state.entries.filter((e) => e.kind === 'character');
    const settingEntries = state.entries.filter((e) => e.kind === 'setting');
    const groups = parseNameList($('#nf-names').value);
    const allowedEntries = chars.filter((e) => e.allowed);
    const allowedNames = new Set(allowedEntries.flatMap(namesOfEntry));
    const isAllowed = (g) => g.some((n) => allowedNames.has(n));
    const forbidden = groups.filter((g) => !isAllowed(g));
    const charName = c.name2 || currentCharacter()?.name || '{{char}}';
    const userName = c.name1 || '';
    const allNames = groups.flat();
    let world = joinWorld(settingEntries, Number(s.worldBudget) || 12000);
    if (s.mask) world = maskNames(world, forbidden.flat());
    const roster = forbidden.map((g) => {
        const e = chars.find((x) => namesOfEntry(x).some((n) => g.includes(n)));
        return { names: g, bio: s.withBio && e ? (s.mask ? maskNames(shortBio(e), allNames.filter((n) => !g.includes(n))) : shortBio(e)) : '' };
    });
    const allowed = allowedEntries.map((e) => ({ names: namesOfEntry(e), content: s.mask ? maskNames(e.content, forbidden.flat()) : e.content }));
    return {
        world,
        roster,
        allowed,
        forbidden,
        identities: [...groups.filter(isAllowed), [charName], userName ? [userName] : []].filter((g) => g.length),
        charName,
        userName,
        charCard: s.withCard ? cardText() : '',
        request: requestText(),
    };
}

function requestText() {
    const bits = [];
    const gender = $('#nf-gender').value;
    const age = $('#nf-age').value.trim();
    const role = $('#nf-role').value.trim();
    if (gender) bits.push(`性别：${gender}`);
    if (age) bits.push(`年龄：${age}`);
    if (role) bits.push(`定位 / 与主角的关系：${role}`);
    const free = $('#nf-request').value.trim();
    if (free) bits.push(free);
    return bits.join('\n');
}

// ---------------- 生成 ----------------

async function runChecked(kind, prompt, m) {
    const s = state.s;
    const signal = state.busy.signal;
    const system = s.system;
    setStatus(kind, '生成中…', 'busy');
    let text = await callLLM({ system, prompt, settings: s, signal });
    let check = checkOutput(text, m.forbidden, m.identities);
    // NSFW 资料不一定带姓名字段，名字以 SFW 为准
    if (kind === 'nsfw') check.nameClash = '';
    let tries = 0;
    while (s.autoFix && hasViolation(check) && tries < Number(s.fixTries || 0)) {
        tries++;
        setStatus(kind, `发现问题，自动修正第 ${tries} 次…（${violationText(check)}）`, 'busy');
        text = await callLLM({ system, prompt: `${prompt}\n\n---\n\n${buildRepairPrompt(text, check)}`, settings: s, signal });
        check = checkOutput(text, m.forbidden, m.identities);
        if (kind === 'nsfw') check.nameClash = '';
    }
    return { text, check };
}

function showCheck(kind, check) {
    if (hasViolation(check)) setStatus(kind, `⚠ ${violationText(check)}`, 'warn');
    else setStatus(kind, `✓ 没有使用世界书里的已有人物${check.newName ? `（新角色：${check.newName}）` : ''}`, 'ok');
}

async function guard(fn) {
    if (state.busy) return;
    state.busy = new AbortController();
    state.root.classList.add('nf-busy');
    try {
        await fn();
    } catch (e) {
        if (e?.name === 'AbortError' || state.busy?.signal.aborted) toast('info', '已停止');
        else {
            console.error('[NewFace]', e);
            toast('error', e?.message || String(e));
        }
    } finally {
        state.busy = null;
        state.root?.classList.remove('nf-busy');
    }
}

function genSfw() {
    return guard(async () => {
        const m = material();
        if (!state.entries.length) toast('warning', '没有读到任何世界书条目，将只根据角色卡生成');
        const prompt = buildSfwPrompt({ ...m, fields: state.s.sfwFields });
        const { text, check } = await runChecked('sfw', prompt, m);
        state.sfw = text;
        $('#nf-sfw').value = text;
        showCheck('sfw', check);
        if (state.s.mode === 'both') {
            state.nsfw = '';
            $('#nf-nsfw').value = '';
            await genNsfwInner(m);
        }
        pushHistory();
    });
}

async function genNsfwInner(m = material()) {
    const sfw = $('#nf-sfw').value.trim();
    if (!sfw) throw new Error('请先生成（或填写）SFW 基础资料');
    const prompt = buildNsfwPrompt({ ...m, sfw, fields: state.s.nsfwFields });
    const { text, check } = await runChecked('nsfw', prompt, m);
    state.nsfw = text;
    $('#nf-nsfw').value = text;
    showCheck('nsfw', check);
}

function genNsfw() {
    return guard(async () => {
        await genNsfwInner();
        pushHistory();
    });
}

function recheck() {
    const m = material();
    const a = checkOutput($('#nf-sfw').value, m.forbidden, m.identities);
    const b = checkOutput($('#nf-nsfw').value, m.forbidden, m.identities);
    b.nameClash = '';
    if ($('#nf-sfw').value.trim()) showCheck('sfw', a);
    if ($('#nf-nsfw').value.trim()) showCheck('nsfw', b);
}

function fixNow(kind) {
    return guard(async () => {
        const m = material();
        const box = $(`#nf-${kind}`);
        const check = checkOutput(box.value, m.forbidden, m.identities);
        if (kind === 'nsfw') check.nameClash = '';
        if (!hasViolation(check)) {
            showCheck(kind, check);
            return;
        }
        setStatus(kind, '修正中…', 'busy');
        const text = await callLLM({ system: state.s.system, prompt: buildRepairPrompt(box.value, check), settings: state.s, signal: state.busy.signal });
        box.value = text;
        const again = checkOutput(text, m.forbidden, m.identities);
        if (kind === 'nsfw') again.nameClash = '';
        showCheck(kind, again);
    });
}

function setStatus(kind, text, cls) {
    const el = $(`#nf-${kind}-status`);
    el.textContent = text;
    el.className = `nf-status nf-${cls}`;
}

function fullText() {
    const sfw = $('#nf-sfw').value.trim();
    const nsfw = $('#nf-nsfw').value.trim();
    return [sfw, nsfw && `【NSFW 资料】\n${nsfw}`].filter(Boolean).join('\n\n');
}

function newName() {
    return parseNewName($('#nf-sfw').value) || '新角色';
}

function pushHistory() {
    const s = state.s;
    const sfw = $('#nf-sfw').value.trim();
    if (!sfw) return;
    s.history.unshift({ time: Date.now(), char: currentCharacter()?.name || '', name: newName(), sfw, nsfw: $('#nf-nsfw').value.trim() });
    s.history = s.history.slice(0, HISTORY_MAX);
    saveSettings();
    renderHistory();
}

// ---------------- 渲染 ----------------

function renderBooks() {
    const box = $('#nf-books');
    if (!state.books.length) {
        box.innerHTML = '<div class="nf-muted">当前角色没有绑定世界书。可以在下面手动添加一本。</div>';
        return;
    }
    box.innerHTML = state.books.map((b, i) => `
        <label class="nf-chip" title="${esc(b.source)}">
            <input type="checkbox" data-book="${i}" ${b.on ? 'checked' : ''}>
            <span>${esc(b.name)}</span><small>${esc(b.source)}</small>
        </label>`).join('');
}

function renderEntries() {
    const filter = $('#nf-filter').value.trim();
    const show = $('#nf-show').value;
    const list = state.entries.filter((e) => (show === 'all' || e.kind === show)
        && (!filter || e.title.includes(filter) || e.keys.some((k) => k.includes(filter)) || e.content.includes(filter)));
    const counts = { character: 0, setting: 0, skip: 0 };
    for (const e of state.entries) counts[e.kind]++;
    $('#nf-counts').textContent = `人物 ${counts.character} · 设定 ${counts.setting} · 忽略 ${counts.skip}`;
    $('#nf-entries').innerHTML = list.map((e) => `
        <div class="nf-entry nf-k-${e.kind}" data-uid="${esc(e.uid)}">
            <select data-kind>
                <option value="character" ${e.kind === 'character' ? 'selected' : ''}>人物</option>
                <option value="setting" ${e.kind === 'setting' ? 'selected' : ''}>设定</option>
                <option value="skip" ${e.kind === 'skip' ? 'selected' : ''}>忽略</option>
            </select>
            <div class="nf-entry-main">
                <div class="nf-entry-title">${esc(e.title || e.keys.join('、') || '(无标题)')}${e.constant ? ' <small>常驻</small>' : ''} <small class="nf-muted">${esc(e.book)}</small></div>
                <div class="nf-entry-body">${esc(e.content.slice(0, 140))}</div>
            </div>
            ${e.kind === 'character' ? `<label class="nf-allow" title="勾选后新角色可以和此人有关系，并会把此人完整资料发给 AI"><input type="checkbox" data-allow ${e.allowed ? 'checked' : ''}>允许提及</label>` : ''}
        </div>`).join('') || '<div class="nf-muted">没有条目</div>';
}

function renderHistory() {
    const sel = $('#nf-history');
    sel.innerHTML = `<option value="">历史记录（${state.s.history.length}）</option>${state.s.history.map((h, i) => {
        const d = new Date(h.time);
        return `<option value="${i}">${esc(h.name)} · ${esc(h.char)} · ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</option>`;
    }).join('')}`;
}

async function renderAddBook() {
    const names = await allWorldNames();
    $('#nf-addbook').innerHTML = `<option value="">＋ 添加其他世界书…</option>${names.filter((n) => !state.books.some((b) => b.name === n)).map((n) => `<option>${esc(n)}</option>`).join('')}`;
    const target = $('#nf-target');
    const pref = state.books.find((b) => b.on && b.name !== '(卡内嵌世界书)')?.name;
    target.innerHTML = names.map((n) => `<option ${n === pref ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

function renderSettings() {
    const s = state.s;
    $('#nf-api').value = s.apiMode;
    const profiles = connectionProfiles();
    $('#nf-profile').innerHTML = `<option value="">（选择配置档）</option>${profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === s.profileId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
    $('#nf-profile-row').style.display = s.apiMode === 'profile' ? '' : 'none';
    for (const k of ['maxTokens', 'worldBudget', 'fixTries', 'sfwFields', 'nsfwFields', 'system']) $(`[data-set="${k}"]`).value = s[k];
    for (const k of ['mask', 'withCard', 'withBio', 'autoFix']) $(`[data-opt="${k}"]`).checked = !!s[k];
    $('#nf-mode').value = s.mode;
}

// ---------------- 外壳 ----------------

const TEMPLATE = `
<div class="nf-dialog" role="dialog" aria-label="NewFace 新角色资料">
    <header class="nf-head">
        <div>
            <b>NewFace · 世界书新角色</b>
            <div class="nf-muted" id="nf-sub"></div>
        </div>
        <div class="nf-head-actions">
            <button class="menu_button" data-act="toggle-settings" title="设置"><i class="fa-solid fa-gear"></i></button>
            <button class="menu_button" data-act="close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
    </header>
    <div class="nf-body">
        <section class="nf-settings" id="nf-settings" hidden>
            <div class="nf-row"><label>接口</label>
                <select id="nf-api"><option value="tavern">酒馆当前连接</option><option value="profile">酒馆连接配置档</option></select></div>
            <div class="nf-row" id="nf-profile-row"><label>配置档</label><select id="nf-profile"></select></div>
            <div class="nf-row"><label>最大回复长度</label><input type="number" data-set="maxTokens" min="256" step="256"><small class="nf-muted">仅配置档模式；当前连接沿用酒馆里的设置</small></div>
            <div class="nf-row"><label>设定资料字数上限</label><input type="number" data-set="worldBudget" min="1000" step="1000"></div>
            <div class="nf-row"><label>自动修正次数</label><input type="number" data-set="fixTries" min="0" max="5"></div>
            <label class="nf-block">SFW 字段模板<textarea data-set="sfwFields" rows="8"></textarea></label>
            <label class="nf-block">NSFW 字段模板<textarea data-set="nsfwFields" rows="8"></textarea></label>
            <label class="nf-block">系统提示词<textarea data-set="system" rows="8"></textarea></label>
            <div class="nf-row"><button class="menu_button" data-act="reset-prompts">恢复默认模板与提示词</button></div>
        </section>

        <section>
            <h4>① 世界书 <small class="nf-muted">当前角色绑定的世界书已自动勾选</small></h4>
            <div class="nf-chips" id="nf-books"></div>
            <div class="nf-row">
                <select id="nf-addbook"></select>
                <button class="menu_button" data-act="reload"><i class="fa-solid fa-rotate"></i> 重新读取</button>
            </div>
        </section>

        <section>
            <h4>② 条目分类 <small class="nf-muted" id="nf-counts"></small></h4>
            <div class="nf-muted nf-hint">「人物」条目<b>不会</b>把内容发给 AI，只把名字列进禁用名单；「设定」条目作为世界观资料发送。自动分类不准时手动改一下（会记住）。</div>
            <div class="nf-row">
                <select id="nf-show"><option value="all">全部</option><option value="character">只看人物</option><option value="setting">只看设定</option><option value="skip">只看忽略</option></select>
                <input id="nf-filter" type="search" placeholder="搜索标题 / 关键词 / 内容">
            </div>
            <div class="nf-entries" id="nf-entries"></div>
            <details>
                <summary>禁用名单（自动生成，可编辑；每行一个人物，用 | 分隔别名）</summary>
                <textarea id="nf-names" rows="6"></textarea>
                <button class="menu_button" data-act="rebuild-names">按条目分类重新生成名单</button>
            </details>
        </section>

        <section>
            <h4>③ 想要什么样的新角色</h4>
            <div class="nf-grid">
                <label>性别<select id="nf-gender"><option value="">不限</option><option>女</option><option>男</option><option>双性</option><option>其他</option></select></label>
                <label>年龄<input id="nf-age" placeholder="如 24、二十出头（须成年）"></label>
                <label class="nf-span2">定位 / 与主角的关系<input id="nf-role" placeholder="如：{{char}} 新来的同事；敌对势力的密探"></label>
            </div>
            <textarea id="nf-request" rows="3" placeholder="其他要求：性格、外貌、经历、风格……"></textarea>
            <div class="nf-opts">
                <label title="把设定资料里出现的已有人名替换成占位符，避免 AI 从资料里“捡人”"><input type="checkbox" data-opt="mask">遮蔽设定资料里的人名</label>
                <label><input type="checkbox" data-opt="withCard">附带当前角色卡设定</label>
                <label title="名单里给每人附一句身份，让 AI 避开相同定位"><input type="checkbox" data-opt="withBio">名单附带身份简介</label>
                <label><input type="checkbox" data-opt="autoFix">发现用到已有人物时自动修正</label>
            </div>
            <div class="nf-row">
                <select id="nf-mode"><option value="both">SFW + NSFW</option><option value="sfw">只生成 SFW</option></select>
                <button class="menu_button nf-primary" data-act="gen"><i class="fa-solid fa-wand-magic-sparkles"></i> 生成</button>
                <button class="menu_button nf-stop" data-act="stop"><i class="fa-solid fa-stop"></i> 停止</button>
                <button class="menu_button" data-act="preview" title="查看实际发给 AI 的提示词">预览提示词</button>
            </div>
        </section>

        <section>
            <h4>④ 结果 <select id="nf-history"></select></h4>
            <div class="nf-out">
                <div class="nf-out-head"><b>SFW 资料</b>
                    <span><button class="menu_button" data-act="gen" title="重新生成">🎲</button><button class="menu_button" data-act="fix-sfw">修正</button></span></div>
                <div class="nf-status" id="nf-sfw-status"></div>
                <textarea id="nf-sfw" rows="14"></textarea>
            </div>
            <div class="nf-out">
                <div class="nf-out-head"><b>NSFW 资料</b>
                    <span><button class="menu_button" data-act="nsfw" title="根据上面的 SFW 资料生成 / 重新生成">🎲</button><button class="menu_button" data-act="fix-nsfw">修正</button></span></div>
                <div class="nf-status" id="nf-nsfw-status"></div>
                <textarea id="nf-nsfw" rows="12"></textarea>
            </div>
            <div class="nf-row nf-wrap">
                <button class="menu_button" data-act="check">重新检查</button>
                <button class="menu_button" data-act="copy"><i class="fa-solid fa-copy"></i> 复制全部</button>
                <select id="nf-target" title="写入哪本世界书"></select>
                <button class="menu_button" data-act="to-world"><i class="fa-solid fa-book"></i> 写入世界书</button>
                <button class="menu_button" data-act="to-card"><i class="fa-solid fa-user-plus"></i> 新建角色卡</button>
            </div>
        </section>
    </div>
</div>`;

function bind() {
    const root = state.root;
    root.addEventListener('click', async (e) => {
        if (e.target === root) return close();
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        const s = state.s;
        switch (act) {
            case 'close': return close();
            case 'toggle-settings': $('#nf-settings').hidden = !$('#nf-settings').hidden; return;
            case 'reset-prompts':
                Object.assign(s, { sfwFields: DEFAULT_SFW_FIELDS, nsfwFields: DEFAULT_NSFW_FIELDS, system: DEFAULT_SYSTEM });
                saveSettings();
                renderSettings();
                return;
            case 'reload': return guard(loadBooks);
            case 'rebuild-names': return rebuildNameList();
            case 'gen': return genSfw();
            case 'nsfw': return genNsfw();
            case 'stop': return state.busy?.abort();
            case 'check': return recheck();
            case 'fix-sfw': return fixNow('sfw');
            case 'fix-nsfw': return fixNow('nsfw');
            case 'preview': return preview();
            case 'copy':
                await navigator.clipboard.writeText(fullText());
                return toast('success', '已复制');
            case 'to-world': return toWorld();
            case 'to-card': return toCard();
        }
    });
    root.addEventListener('change', (e) => {
        const t = e.target;
        const s = state.s;
        if (t.dataset.book !== undefined) {
            state.books[Number(t.dataset.book)].on = t.checked;
            return guard(loadEntries);
        }
        if (t.id === 'nf-addbook' && t.value) {
            const key = charKey();
            s.extraBooks[key] = [...new Set([...(s.extraBooks[key] || []), t.value])];
            saveSettings();
            state.books.push({ name: t.value, source: '手动添加', on: true });
            renderAddBook();
            return guard(loadEntries);
        }
        const row = t.closest('.nf-entry');
        if (row && t.matches('[data-kind]')) {
            const en = state.entries.find((x) => x.uid === row.dataset.uid);
            en.kind = t.value;
            s.kinds[en.uid] = t.value;
            saveSettings();
            rebuildNameList();
            return renderEntries();
        }
        if (row && t.matches('[data-allow]')) {
            state.entries.find((x) => x.uid === row.dataset.uid).allowed = t.checked;
            return;
        }
        if (t.id === 'nf-show') return renderEntries();
        if (t.id === 'nf-mode') s.mode = t.value;
        if (t.id === 'nf-api') s.apiMode = t.value;
        if (t.id === 'nf-profile') s.profileId = t.value;
        if (t.dataset.opt) s[t.dataset.opt] = t.checked;
        if (t.dataset.set) s[t.dataset.set] = t.type === 'number' ? Number(t.value) : t.value;
        if (t.id === 'nf-history' && t.value !== '') {
            const h = s.history[Number(t.value)];
            $('#nf-sfw').value = h.sfw;
            $('#nf-nsfw').value = h.nsfw;
            recheck();
        }
        saveSettings();
        if (t.id === 'nf-api') renderSettings();
    });
    root.addEventListener('input', (e) => {
        if (e.target.id === 'nf-filter') renderEntries();
    });
}

async function preview() {
    const m = material();
    const sfw = buildSfwPrompt({ ...m, fields: state.s.sfwFields });
    const html = `<div style="text-align:left"><h3>系统提示词</h3><pre class="nf-pre">${esc(state.s.system)}</pre><h3>SFW 提示词（${sfw.length} 字）</h3><pre class="nf-pre">${esc(sfw)}</pre></div>`;
    const c = ctx();
    if (c.callGenericPopup) await c.callGenericPopup(html, c.POPUP_TYPE?.TEXT ?? 1, '', { wide: true, large: true, allowVerticalScrolling: true });
    else console.log(sfw);
}

async function toWorld() {
    const book = $('#nf-target').value;
    const content = fullText();
    if (!book) return toast('warning', '请选择要写入的世界书');
    if (!content) return toast('warning', '还没有资料');
    const name = newName();
    await guard(async () => {
        await addWorldEntry(book, { name: `人物 - ${name}`, keys: [name], content });
        toast('success', `已写入世界书「${book}」（关键词：${name}）`);
        await loadEntries();
    });
}

async function toCard() {
    const content = fullText();
    if (!content) return toast('warning', '还没有资料');
    const name = newName();
    const book = state.books.find((b) => b.on && b.name !== '(卡内嵌世界书)')?.name || '';
    await guard(async () => {
        await createCharacterCard({ name, description: content, worldName: book });
        toast('success', `已新建角色卡「${name}」${book ? `，绑定世界书「${book}」` : ''}`);
    });
}

function onKey(e) {
    if (e.key === 'Escape' && state.root && !document.querySelector('.popup:not([closing])')) close();
}

export async function open() {
    const ch = currentCharacter();
    if (!ch) {
        toast('warning', '请先打开一个单人角色的对话（群聊不支持）');
        return;
    }
    state.s = settings(DEFAULTS);
    if (state.root) close();
    const root = document.createElement('div');
    root.className = 'nf-overlay';
    root.innerHTML = TEMPLATE;
    document.body.appendChild(root);
    state.root = root;
    state.entries = [];
    bind();
    document.addEventListener('keydown', onKey);
    $('#nf-sub').textContent = `当前角色：${ch.name}`;
    renderSettings();
    renderHistory();
    await guard(async () => {
        await loadBooks();
        await renderAddBook();
    });
}

export function close() {
    state.busy?.abort();
    state.root?.remove();
    state.root = null;
    document.removeEventListener('keydown', onKey);
}

