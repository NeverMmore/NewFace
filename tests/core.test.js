import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_NSFW_FEMALE, DEFAULT_NSFW_MALE, DEFAULT_SFW_FIELDS,
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
    assert.match(mergeProfile(SFW, '女性NSFW设定:\n身体细节:\n屁股:\n形状: 圆'), /\n {2}女性NSFW设定:\n {4}身体细节:\n {4}屁股:\n {4}形状: 圆\n/);
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
