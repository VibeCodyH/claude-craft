import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../hooks/register'

describe('classify', () => {
  test('holds the risky shapes and lets the rest through', () => {
    expect(classify('rm -rf build')?.kind).toBe('rm')
    expect(classify('cd /repo && rm -r dist out')?.dir).toBe('/repo')
    expect(classify('rm -rf /tmp/pgl')).toBeNull()
    expect(classify('rm notes.txt')).toBeNull()
    expect(classify('git -C /repo reset --hard origin/main')?.dir).toBe('/repo')
    expect(classify('git reset --soft HEAD~1')).toBeNull()
    expect(classify('git clean -fdx')?.kind).toBe('clean')
    expect(classify('git clean -n')).toBeNull()
    expect(classify('git push --force-with-lease origin x')?.kind).toBe('push')
    expect(classify('git push origin x')).toBeNull()
    expect(classify('git branch -D old')?.kind).toBe('branch')
    expect(classify('git checkout -- .')?.kind).toBe('discard')
    expect(classify('git restore --staged .')).toBeNull()
    expect(classify('npm run db:migrate:prod')?.kind).toBe('migrate')
    expect(classify('sudo nice rm -rf node_modules')?.kind).toBe('rm')
    expect(classify('mywrap rm -rf node_modules')).toBeNull()
    expect(classify('mywrap rm -rf node_modules', new Set(['mywrap']))?.kind).toBe('rm')
    expect(classify('git status && ls')).toBeNull()
  })
})

