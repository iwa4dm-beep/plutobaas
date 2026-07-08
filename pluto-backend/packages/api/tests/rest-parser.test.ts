// Unit tests for the /rest/v1 query-string parser. Runs with `node --test`
// (built-in test runner — no extra deps). These lock in the PostgREST-style
// `or=(...)`, `ilike`, `order`, and pagination grammar so admissions search
// regressions surface fast.
//
// Run: `pnpm --filter @pluto/api exec node --test --import tsx tests/rest-parser.test.ts`
// or from repo root: `node --test --import tsx pluto-backend/packages/api/tests/rest-parser.test.ts`

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFilters,
  buildWhere,
  parseSegment,
  parseGroup,
  splitTopLevel,
  RestParseError,
} from '../src/routes/rest-parser.js';

describe('splitTopLevel', () => {
  it('splits on top-level commas, respects nested parens', () => {
    assert.deepEqual(splitTopLevel('a,b,c'), ['a', 'b', 'c']);
    assert.deepEqual(splitTopLevel('a,in.(1,2,3),c'), ['a', 'in.(1,2,3)', 'c']);
    assert.deepEqual(splitTopLevel('or(a.eq.1,b.eq.2),x.eq.3'), ['or(a.eq.1,b.eq.2)', 'x.eq.3']);
  });
  it('rejects unbalanced parens', () => {
    assert.throws(() => splitTopLevel('a,(b,c'), (e: any) => e instanceof RestParseError);
  });
});

describe('parseSegment', () => {
  it('parses col.op.value', () => {
    assert.deepEqual(parseSegment('id.eq.42'), { col: 'id', op: 'eq', value: '42', negate: false });
  });
  it('parses ilike with wildcards', () => {
    assert.deepEqual(parseSegment('student_name.ilike.*0181*'),
      { col: 'student_name', op: 'ilike', value: '*0181*', negate: false });
  });
  it('parses not.eq', () => {
    assert.deepEqual(parseSegment('id.not.eq.5'), { col: 'id', op: 'eq', value: '5', negate: true });
  });
  it('surfaces the failing segment on unknown operator', () => {
    assert.throws(() => parseSegment('id.zzz.5'), (e: any) =>
      e instanceof RestParseError && e.message === 'unknown_operator' && e.detail.operator === 'zzz');
  });
});

describe('parseGroup (or / and)', () => {
  it('parses a flat OR group', () => {
    const node = parseGroup('(id.ilike.*x*,student_name.ilike.*x*,mobile.ilike.*x*)', 'OR');
    assert.equal(node.kind, 'group');
    if (node.kind === 'group') {
      assert.equal(node.op, 'OR');
      assert.equal(node.children.length, 3);
    }
  });
  it('rejects a value that is not parenthesised', () => {
    assert.throws(() => parseGroup('id.eq.1,x.eq.2', 'OR'), (e: any) =>
      e instanceof RestParseError && e.message === 'bad_group_syntax');
  });
});

describe('parseFilters + buildWhere', () => {
  it('renders `or=(...)` as a parenthesised OR', () => {
    const q = parseFilters({ or: '(id.ilike.*0181*,student_name.ilike.*0181*,mobile.ilike.*0181*)' });
    const { sql, params } = buildWhere(q.nodes);
    assert.equal(sql,
      `WHERE ("id" ILIKE $1 OR "student_name" ILIKE $2 OR "mobile" ILIKE $3)`);
    assert.deepEqual(params, ['*0181*', '*0181*', '*0181*']);
  });

  it('mixes a top-level filter with an OR group', () => {
    const q = parseFilters({
      or: '(a.eq.1,b.eq.2)',
      class_applying_for: 'eq.5',
    });
    const { sql, params } = buildWhere(q.nodes);
    assert.equal(sql, `WHERE ("a" = $1 OR "b" = $2) AND "class_applying_for" = $3`);
    assert.deepEqual(params, ['1', '2', '5']);
  });

  it('parses order + limit + offset', () => {
    const q = parseFilters({ order: 'created_at.desc,id.asc', limit: '50', offset: '100' });
    assert.equal(q.order, 'created_at.desc,id.asc');
    assert.equal(q.limit, 50);
    assert.equal(q.offset, 100);
  });

  it('parses in.(...) with a comma-separated list', () => {
    const q = parseFilters({ id: 'in.(a,b,c)' });
    const { sql, params } = buildWhere(q.nodes);
    assert.equal(sql, `WHERE "id" IN ($1,$2,$3)`);
    assert.deepEqual(params, ['a', 'b', 'c']);
  });

  it('rejects an invalid column name with the failing segment', () => {
    assert.throws(() => parseFilters({ 'drop table': 'eq.1' }), (e: any) =>
      e instanceof RestParseError && e.detail.column === 'drop table');
  });
});
