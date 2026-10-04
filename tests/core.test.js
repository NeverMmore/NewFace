import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    DEFAULT_NSFW_FEMALE, DEFAULT_NSFW_MALE, DEFAULT_SFW_FIELDS, TEMPLATE_VERSION, buildNsfwPrompt, migrateTemplates, normalizeNsfw, textHash, topLevelKeys,
    buildSfwPrompt, checkOutput, cleanTitle, genderOf, guessKind, hasViolation, joinWorld, maskNames, mergeProfile, namesOfEntry, normEntry, parseNameList, parseNewName,
} from '../src/core.js';

const e = (o) => normEntry({ uid: 1, key: [], comment: '', content: '', ...o }, 'B');

test('分类：人物 / 设定', () => {
    assert.equal(guessKind(e({ comment: '角色 - 林晚', content: '...' })), 'character');
    assert.equal(guessKind(e({ comment: '苏瑶', content: '性别：女\n年龄：22\n外貌：长发' })), 'character');
    assert.equal(guessKind(e({ comment: '青云宗', content: '修仙门派，位于东海' })), 'setting');
    assert.equal(guessKind(e({ comment: '世界观', content: '性别：无关 年龄：千年' })), 'setting');
    assert.equal(guessKind(e({ comment: 'x', content: '姓名：张三\n很普通' })), 'character');
});

test('取名字和别名', () => {
    assert.equal(cleanTitle('【角色】林晚（女主）'), '林晚');
    assert.equal(cleanTitle('人物：苏瑶 - 学生会长'), '苏瑶');
    const names = namesOfEntry(e({ comment: '角色 - 林晚', key: ['林晚', '晚晚', '老师', 'L'], content: '姓名：林晚' }));
    assert.deepEqual(names, ['林晚', '晚晚']);
});

test('遮蔽人名，长名优先', () => {
    assert.equal(maskNames('林晚和林晚晴是姐妹', ['林晚', '林晚晴'], 'X'), 'X和X是姐妹');
});

test('名单解析', () => {
    assert.deepEqual(parseNameList('林晚 | 晚晚\n\n苏瑶'), [['林晚', '晚晚'], ['苏瑶']]);
});

test('检查：提及与重名', () => {
    const forbidden = [['林晚', '晚晚'], ['苏瑶']];
    const ok = checkOutput('姓名：沈青禾\n性别：女\n与 {{char}} 的关系：同事', forbidden, [['陈默']]);
    assert.equal(ok.newName, '沈青禾');
    assert.equal(hasViolation(ok), false);
    const bad = checkOutput('**姓名**：苏瑶儿\n她是晚晚的表妹', forbidden, []);
    assert.equal(bad.nameClash, '苏瑶');
    assert.equal(bad.mentions.find((m) => m.name.startsWith('林晚')).name, '林晚（晚晚）');
    const clash = checkOutput('姓名：陈默\n', forbidden, [['陈默']]);
    assert.equal(clash.nameClash, '陈默');
});

test('读新名字', () => {
    assert.equal(parseNewName('- 姓名：沈青禾（Shen）\n'), '沈青禾');
    assert.equal(parseNewName('Name: Alice Grey\n'), 'Alice Grey');
});

const SFW = `\`\`\`yaml
<沈青禾>
  基本信息:
    姓名: 沈青禾
    年龄: 24岁
    性别: 女
    身份: 散修药师
    与{{user}}关系: 救命恩人

  外貌特征:
    形象概述: 清冷
    身高: 165cm

  背景设定:
    出身经历:
      - 十岁拜师
</沈青禾>
\`\`\``;

test('新格式：标签名、性别', () => {
    assert.equal(parseNewName(SFW), '沈青禾');
    assert.equal(parseNewName('<白露>\n  基本信息:\n    年龄: 20岁'), '白露');
    assert.equal(parseNewName('<角色姓名>\n'), '');
    assert.equal(genderOf(SFW), 'female');
    assert.equal(genderOf('    性别: 男'), 'male');
    assert.equal(genderOf('    性别: 未知'), '');
});

test('合并：NSFW 插在背景设定前，去掉代码块和多余标签', () => {
    const nsfw = '```\n<沈青禾>\n女性NSFW设定:\n  身体细节:\n    屁股:\n      形状: 圆\n</沈青禾>\n```';
    const out = mergeProfile(SFW, nsfw);
    assert.ok(!out.includes('```'));
    assert.ok(out.startsWith('<沈青禾>\n'));
    assert.ok(out.endsWith('</沈青禾>'));
    const iN = out.indexOf('  女性NSFW设定:');
    assert.ok(iN > out.indexOf('身高: 165cm') && iN < out.indexOf('  背景设定:'));
    assert.match(out, /\n {8}形状: 圆\n/);
    assert.equal(out.split('<沈青禾>').length, 2, '只保留一对标签');
});

test('合并：AI 先复述了基础资料，只取 NSFW 那段', () => {
    const out = mergeProfile(SFW, '好的，以下是资料：\n  女性NSFW设定:\n    身体细节: 略');
    assert.ok(!out.includes('好的'));
    assert.match(out, /\n {2}女性NSFW设定:\n {4}身体细节: 略\n/);
});

test('合并：没有背景设定时插在结束标签前；没有标签时补上', () => {
    const out = mergeProfile('<甲乙>\n  基本信息:\n    姓名: 甲乙\n</甲乙>', '  男性NSFW设定:\n    身体细节: 略');
    assert.match(out, /姓名: 甲乙\n\n {2}男性NSFW设定:\n {4}身体细节: 略\n\n<\/甲乙>$/);
    const bare = mergeProfile('基本信息:\n  姓名: 丙丁', '');
    assert.equal(bare, '<丙丁>\n  基本信息:\n    姓名: 丙丁\n</丙丁>');
    assert.equal(mergeProfile('', '  女性NSFW设定: x'), '  女性NSFW设定: x');
});

test('合并：保留 NSFW 块的相对缩进（首行带缩进、零缩进、四格缩进）', () => {
    const want = /\n {2}女性NSFW设定:\n {4}身体细节:\n {6}屁股:\n/;
    for (const raw of [
        '  女性NSFW设定:\n    身体细节:\n      屁股:\n        形状: 圆',
        '女性NSFW设定:\n  身体细节:\n    屁股:\n      形状: 圆',
        '\n\n    女性NSFW设定:\n      身体细节:\n        屁股:\n          形状: 圆\n\n',
        '女性NSFW设定:\r\n  身体细节:\r\n    屁股:\r\n      形状: 圆',
    ]) assert.match(mergeProfile(SFW, raw), want, JSON.stringify(raw));
});

test('默认模板结构', () => {
    for (const k of ['基本信息:', '外貌特征:', '背景设定:', '关系设定:', '性格架构:', '底层认知-防备机制:', '显性性格-日常做派:', '应激反差-受挫状态:', '二次解释:']) {
        assert.ok(DEFAULT_SFW_FIELDS.includes(k), k);
    }
    assert.match(DEFAULT_NSFW_FEMALE, /^ {2}女性NSFW设定:/);
    assert.match(DEFAULT_NSFW_MALE, /^ {2}男性NSFW设定:/);
    // 模板本身合并后结构也对
    const merged = mergeProfile(DEFAULT_SFW_FIELDS, DEFAULT_NSFW_FEMALE);
    assert.ok(merged.indexOf('女性NSFW设定') > merged.indexOf('外貌特征') && merged.indexOf('女性NSFW设定') < merged.indexOf('背景设定'));
});

// ---- 审查发现的问题（回归测试） ----

const NSFW_WANT = /\n {2}女性NSFW设定:\n {4}身体细节:\n {6}屁股:\n {8}形状: 圆\n\n {2}背景设定:/;

test('回归：酒馆 trim 掉第一行缩进后，NSFW 子项层级不变', () => {
    // 模型原样输出是 "  女性NSFW设定:\n    身体细节:…"，trim 后首行缩进没了
    assert.match(mergeProfile(SFW, '女性NSFW设定:\n    身体细节:\n      屁股:\n        形状: 圆'), NSFW_WANT);
});

test('回归：NSFW 前后有闲话、标题在句子里、后面又抄了一遍基础资料', () => {
    const raw = '好的，以下是她的女性NSFW设定：\n\n  女性NSFW设定:\n    身体细节:\n      屁股:\n        形状: 圆\n\n  背景设定:\n    出身经历:\n      - 十岁拜师\n\n希望对你有帮助！';
    const out = mergeProfile(SFW, raw);
    assert.match(out, NSFW_WANT);
    assert.ok(!out.includes('好的') && !out.includes('希望'));
    assert.equal(out.split('背景设定:').length, 2, '背景设定只出现一次');
    // 去掉首行缩进 + 末尾闲话
    assert.match(mergeProfile(SFW, '女性NSFW设定:\n    身体细节:\n      屁股:\n        形状: 圆\n以上。'), NSFW_WANT);
    // 完全平铺（没有缩进层级）也不会被截断
    // 平铺写法：模板里的段落标题当段落，其余字段收进段落里
    assert.match(mergeProfile(SFW, '女性NSFW设定:\n身体细节:\n屁股:\n形状: 圆'), /\n {2}女性NSFW设定:\n {4}身体细节:\n {6}屁股:\n {6}形状: 圆\n/);
});

test('回归：SFW 标签前后有闲话时只取标签内', () => {
    const out = mergeProfile(`好的，下面是新角色：\n\n${SFW}\n\n需要我再生成 NSFW 吗？`, '');
    assert.ok(out.startsWith('<沈青禾>\n') && out.endsWith('</沈青禾>'));
    assert.equal(out.split('<沈青禾>').length, 2);
});

test('回归：模板占位标签换成真实姓名；缺结束标签补上', () => {
    const out = mergeProfile('<角色姓名>\n  基本信息:\n    姓名: 林青\n</角色姓名>', '');
    assert.ok(out.startsWith('<林青>\n') && out.endsWith('</林青>'));
    assert.ok(mergeProfile('<姓名>\n  基本信息:\n    姓名: 林青', '').endsWith('\n</林青>'));
});

test('回归：NSFW 块与 SFW 大标题同级（SFW 用 0 缩进时）', () => {
    const out = mergeProfile('<甲乙>\n基本信息:\n  姓名: 甲乙\n背景设定:\n  - x\n</甲乙>', '  女性NSFW设定:\n    身体细节: 略');
    assert.match(out, /\n女性NSFW设定:\n {2}身体细节: 略\n\n背景设定:/);
});

test('回归：姓名/性别字段为空时不读下一行', () => {
    assert.equal(parseNewName('<林青>\n  基本信息:\n    姓名:\n    年龄: 20岁'), '林青');
    assert.equal(genderOf('    性别:\n    身份: 女装店老板'), '');
    assert.equal(genderOf('    性别: 男（外表酷似女性）'), 'male');
    assert.equal(genderOf('- **性别**: 女'), 'female');
});

test('回归：标签名与已有人物重名也算违规', () => {
    const c = checkOutput('<陈默>\n  基本信息:\n    姓名: 沈青禾', [], [['陈默']]);
    assert.equal(c.nameClash, '陈默');
    assert.equal(c.clashName, '陈默');
});

// ---- 性经验与偏好 等字段（模板版本 3） ----

test('NSFW 模板含性经验、敏感带、性癖等字段，身体细节在前', () => {
    for (const tpl of [DEFAULT_NSFW_FEMALE, DEFAULT_NSFW_MALE]) {
        for (const k of ['性经验与偏好:', '性取向:', '性经验:', '性观念:', '敏感带:', '性癖:', '雷区与底线:', '自慰习惯:', '性幻想:', '亲密时的反差:', '发展亲密关系的契机:']) {
            assert.ok(tpl.includes(k), k);
        }
        assert.ok(tpl.indexOf('身体细节:') < tpl.indexOf('性经验与偏好:'));
        assert.match(tpl, /\n {4}性经验与偏好:\n {6}性取向:/, '与身体细节同级');
    }
    // 模板原样合并后层级不乱
    const merged = mergeProfile(SFW, DEFAULT_NSFW_FEMALE);
    assert.match(merged, /\n {2}女性NSFW设定:\n {4}身体细节:/);
    assert.match(merged, /\n {4}性经验与偏好:\n {6}性取向:/);
    assert.match(merged, /\n {4}亲密时的反差:\n {6}- （/);
    assert.ok(merged.indexOf('发展亲密关系的契机') < merged.indexOf('  背景设定:'));
});

const FULL = '  女性NSFW设定:\n    身体细节:\n      屁股:\n        形状: 圆\n    性经验与偏好:\n      性经验: 无\n      敏感带: 耳后\n    亲密时的反差:\n      - 会哭';
const FULL_WANT = /\n {2}女性NSFW设定:\n {4}身体细节:\n {6}屁股:\n {8}形状: 圆\n {4}性经验与偏好:\n {6}性经验: 无\n {6}敏感带: 耳后\n {4}亲密时的反差:\n {6}- 会哭\n\n {2}背景设定:/;

test('新增段落：正常、首行被 trim、整体多缩进、后面有闲话，层级都对', () => {
    assert.match(mergeProfile(SFW, FULL), FULL_WANT);
    assert.match(mergeProfile(SFW, FULL.trimStart()), FULL_WANT);
    assert.match(mergeProfile(SFW, FULL.replace(/^/gm, '  ')), FULL_WANT);
    assert.match(mergeProfile(SFW, `${FULL}\n\n希望这份设定对你有帮助！`), FULL_WANT);
});

test('新增段落：AI 把「性经验与偏好」写成与 NSFW 标题同级，也收回到标题下面', () => {
    const sibling = '  女性NSFW设定:\n    身体细节:\n      屁股:\n        形状: 圆\n  性经验与偏好:\n    性经验: 无\n    敏感带: 耳后\n  亲密时的反差:\n    - 会哭';
    assert.match(mergeProfile(SFW, sibling), FULL_WANT);
    // 同级段落后面接基础资料的大标题，照样截断
    const out = mergeProfile(SFW, `${sibling}\n  背景设定:\n    出身经历:\n      - 十岁拜师`);
    assert.match(out, FULL_WANT);
    assert.equal(out.split('背景设定:').length, 2);
});

// ---- 第二轮审查发现的问题（回归测试） ----

test('回归：末尾带冒号的备注 / 免责声明 / 客套话不会混进资料', () => {
    for (const trailer of [
        '（注：该角色已满18岁，以上内容纯属虚构）', '注：以上内容纯属虚构。', '以上就是她的设定：', '*注：所有角色均为成年人*',
        'Note: all characters are adults.', '备注：角色已成年', '注意：本设定中所有角色均已成年。', '如需调整请告诉我：', '说明：以上设定可根据剧情需要再调整。',
    ]) {
        for (const sep of ['\n\n', '\n']) {
            const out = mergeProfile(SFW, `${FULL}${sep}${trailer}`);
            assert.match(out, FULL_WANT, trailer);
            assert.ok(!out.includes(trailer.replace(/^[（*]/, '').slice(0, 4)), trailer);
        }
    }
});

test('回归：标题缩进被 trim + 同级写法的段落，层级仍然一致', () => {
    const sibling = '女性NSFW设定:\n    身体细节:\n      屁股:\n        形状: 圆\n\n  性经验与偏好:\n    性经验: 无\n    敏感带: 耳后\n\n  亲密时的反差:\n    - 会哭';
    assert.match(mergeProfile(SFW, sibling), FULL_WANT);
    const out = mergeProfile(SFW, `${sibling}\n  背景设定:\n    出身经历:\n      - 十岁拜师`);
    assert.match(out, FULL_WANT);
    assert.equal(out.split('背景设定:').length, 2);
});

test('回归：重新抄写的基础资料（markdown 标题、带值、自定义大标题）都会被截掉', () => {
    const cases = [
        `${FULL}\n  **背景设定**:\n    出身经历:\n      - 十岁拜师`,
        `${FULL}\n  背景设定: （同基础资料，略）\n  关系设定: （略）`,
    ];
    for (const raw of cases) {
        const out = mergeProfile(SFW, raw);
        assert.match(out, FULL_WANT, raw);
        assert.ok(!out.includes('略）'), raw);
    }
    // 用户自定义 SFW 模板里的大标题
    const custom = SFW.replace('  背景设定:', '  能力设定:\n    剑术: 高\n\n  背景设定:');
    const out = mergeProfile(custom, `${FULL}\n  能力设定:\n    剑术: 高`);
    assert.equal(out.split('能力设定:').length, 2, '自定义大标题只出现一次');
    // NSFW 块被 AI 嵌在外貌特征里：后面外貌字段不收进来
    const nested = normalizeNsfw('  外貌特征:\n    身高: 165cm\n    女性NSFW设定:\n      身体细节:\n        形状: 圆\n    发型: 长发\n    肤色: 白');
    assert.equal(nested, '  女性NSFW设定:\n    身体细节:\n      形状: 圆');
});

test('回归：平铺写法的散文值、* 列表、制表符缩进都不会丢', () => {
    const flat = mergeProfile(SFW, '女性NSFW设定:\n身体细节:\n屁股: 圆\n亲密时的反差:\n平时冷淡，亲密时会撒娇。\n发展亲密关系的契机:\n- 雨夜');
    assert.match(flat, /撒娇。\n {4}发展亲密关系的契机:\n {6}- 雨夜\n/);
    const tabs = mergeProfile(SFW, '  女性NSFW设定:\n\t身体细节:\n\t\t屁股: 圆\n\t亲密时的反差:\n\t\t会哭得很厉害\n\t发展亲密关系的契机:\n\t\t- 雨夜');
    assert.match(tabs, /\n {4}亲密时的反差:\n {6}会哭得很厉害\n {4}发展亲密关系的契机:\n {6}- 雨夜\n/);
    const stars = mergeProfile(SFW, '  女性NSFW设定:\n    亲密时的反差:\n      - 会哭\n  发展亲密关系的契机:\n  * 雨夜\n  * 受伤时');
    assert.match(stars, /\n {4}发展亲密关系的契机:\n {6}\* 雨夜\n {6}\* 受伤时\n/);
});

test('回归：规整是幂等的（界面里规整过的文字合并时不再变）', () => {
    for (const raw of [FULL, FULL.trimStart(), '女性NSFW设定:\n身体细节:\n屁股: 圆\n亲密时的反差:\n平时冷淡。']) {
        const once = normalizeNsfw(raw, 2, { stopKeys: topLevelKeys(SFW) });
        assert.equal(normalizeNsfw(once, 2, { stopKeys: topLevelKeys(SFW) }), once);
    }
});

test('对抗测试夹具：16 种 AI 输出写法都规整成同一结构，且规整结果是幂等的', () => {
    const { sfw, cases } = JSON.parse(readFileSync(new URL('./fixtures/nsfw-breakers.json', import.meta.url), 'utf8'));
    for (const [i, c] of cases.entries()) {
        const out = mergeProfile(sfw, c.input);
        const block = out.slice(out.indexOf('身高: 165cm') + 10, out.indexOf('  背景设定:')).replace(/^\s*\n/, '').trimEnd();
        assert.equal(block, c.expected, `#${i + 1} ${c.why}`);
        assert.equal(out.split('背景设定:').length, 2, `#${i + 1} 基础资料没有被重复`);
        assert.equal(mergeProfile(sfw, block), out, `#${i + 1} 幂等`);
    }
});

test('自定义 NSFW 模板的段落也能识别', () => {
    const tpl = '  女性NSFW设定:\n    身体细节:\n      屁股:\n    口癖与叫声:\n      - （…）';
    const raw = '女性NSFW设定:\n    身体细节:\n      屁股: 圆\n  口癖与叫声:\n    - 小声\n\n希望你喜欢！';
    const out = mergeProfile(SFW, raw, { templates: [tpl] });
    assert.match(out, /\n {4}口癖与叫声:\n {6}- 小声\n\n {2}背景设定:/);
    assert.ok(!out.includes('希望'));
});

test('AI 漏写 NSFW 标题时按性别补上', () => {
    const out = mergeProfile(SFW, '身体细节:\n      屁股:\n        形状: 圆\n    性经验与偏好:\n      敏感带: 耳后');
    assert.match(out, /\n {2}女性NSFW设定:\n {4}身体细节:\n {6}屁股:\n {8}形状: 圆\n {4}性经验与偏好:\n {6}敏感带: 耳后\n/);
});

test('回归：NSFW 提示词只要求模板里有的字段', () => {
    const base = { world: '', roster: [], allowed: [], sfw: SFW, request: '' };
    const V2_FEMALE = DEFAULT_NSFW_FEMALE.slice(0, DEFAULT_NSFW_FEMALE.indexOf('\n    性经验与偏好:'));
    const oldPrompt = buildNsfwPrompt({ ...base, fields: V2_FEMALE });
    assert.ok(!/性癖|性经验|反差/.test(oldPrompt), '旧模板：提示词不提模板里没有的字段');
    assert.match(buildNsfwPrompt({ ...base, fields: DEFAULT_NSFW_FEMALE }), /性癖和反差要贴合这个人/);
});

test('模板迁移：v1 全换并备份；v2 没改过的换、改过的保留；当前版本不动', () => {
    // 新安装（settings() 已填好默认值）：不产生备份
    const fresh = { sfwFields: DEFAULT_SFW_FIELDS, nsfwFemale: DEFAULT_NSFW_FEMALE, nsfwMale: DEFAULT_NSFW_MALE };
    assert.equal(migrateTemplates(fresh).changed, true);
    assert.equal(fresh.templateVersion, TEMPLATE_VERSION);
    assert.equal(fresh.templateBackupV1, undefined);
    // v0.1.0 用户
    const v1 = { sfwFields: '旧SFW', nsfwFields: '旧NSFW', nsfwFemale: DEFAULT_NSFW_FEMALE, nsfwMale: DEFAULT_NSFW_MALE };
    const r1 = migrateTemplates(v1);
    assert.equal(r1.fromVersion, 1);
    assert.deepEqual(v1.templateBackupV1, { sfwFields: '旧SFW', nsfwFields: '旧NSFW' });
    assert.equal(v1.sfwFields, DEFAULT_SFW_FIELDS);
    assert.ok(!('nsfwFields' in v1));
    // v0.2.0 用户：女性模板没改过（v2 默认值），男性模板改过
    const V2_FEMALE = DEFAULT_NSFW_FEMALE.slice(0, DEFAULT_NSFW_FEMALE.indexOf('\n    性经验与偏好:'));
    const V2_MALE = DEFAULT_NSFW_MALE.slice(0, DEFAULT_NSFW_MALE.indexOf('\n    性经验与偏好:'));
    assert.equal(textHash(V2_FEMALE), 'mrwjzd', '指纹对应 v0.2.0 的女性默认模板');
    assert.equal(textHash(V2_MALE), 'ah8ihm', '指纹对应 v0.2.0 的男性默认模板');
    const v2 = { templateVersion: 2, sfwFields: '我改过的SFW', nsfwFemale: V2_FEMALE, nsfwMale: `${V2_MALE}\n      我加的字段:` };
    const r2 = migrateTemplates(v2);
    assert.deepEqual(r2.kept, ['nsfwMale']);
    assert.equal(v2.nsfwFemale, DEFAULT_NSFW_FEMALE);
    assert.ok(v2.nsfwMale.includes('我加的字段'));
    assert.equal(v2.sfwFields, '我改过的SFW', 'v2→v3 不碰 SFW 模板');
    // 再跑一次不变
    assert.equal(migrateTemplates(v2).changed, false);
});

test('设定资料按预算截断、常驻优先', () => {
    const a = { ...e({ comment: 'A', content: 'a'.repeat(50) }), order: 1 };
    const b = { ...e({ comment: 'B', content: 'b'.repeat(50), constant: true }), order: 9 };
    const out = joinWorld([a, b], 1000);
    assert.ok(out.indexOf('## B') < out.indexOf('## A'));
});

test('提示词不含人物条目全文', () => {
    const p = buildSfwPrompt({
        world: '世界', roster: [{ names: ['林晚'], bio: '老师' }], allowed: [], charName: '陈默', userName: '你', charCard: '', request: '', fields: '姓名：',
    });
    assert.match(p, /林晚：老师/);
    assert.match(p, /陈默（\{\{char\}\}/);
    assert.match(p, /允许提及的已有人物\n\n（无/);
});
