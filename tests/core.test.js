import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSfwPrompt, checkOutput, cleanTitle, guessKind, hasViolation, joinWorld, maskNames, namesOfEntry, normEntry, parseNameList, parseNewName,
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
