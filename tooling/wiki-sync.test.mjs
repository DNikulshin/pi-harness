/**
 * Тесты `tooling/wiki-sync.mjs`.
 *
 * Проверяется то, от чего зависит «делать коммит или нет»: чистая разница страниц и разбор адреса
 * репозитория. Git-часть (клон, push) в тестах не проверяется — она требует сети и прав на
 * wiki-репозиторий; для неё есть `--dry-run` и ручной прогон.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { planSync, readPages, repoSlugFromRemote } from './wiki-sync.mjs';

/** Временные каталоги теста. @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Временный каталог со страницами.
 * @param {Record<string, string>} files имя → содержимое
 * @returns {string} путь каталога
 */
function pages(files) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-pages-'));
  dirs.push(root);
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }

  return root;
}

describe('planSync: что публиковать', () => {
  test('одинаковые страницы — публиковать нечего', () => {
    const plan = planSync({ pages: { 'Home.md': 'текст' }, existing: { 'Home.md': 'текст' } });

    assert.deepEqual(plan, { write: [], remove: [], unchanged: ['Home.md'] });
  });

  test('новая страница — записать, изменённая — тоже', () => {
    const plan = planSync({
      pages: { 'Home.md': 'новый', 'FAQ.md': 'вопросы' },
      existing: { 'Home.md': 'старый' },
    });

    assert.deepEqual(plan.write, ['FAQ.md', 'Home.md']);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.unchanged, []);
  });

  test('страница исчезла из репозитория — удалить из вики', () => {
    const plan = planSync({
      pages: { 'Home.md': 'текст' },
      existing: { 'Home.md': 'текст', 'Old-Page.md': 'осталось с прошлого раза' },
    });

    assert.deepEqual(plan.write, []);
    assert.deepEqual(plan.remove, ['Old-Page.md']);
    assert.deepEqual(plan.unchanged, ['Home.md']);
  });

  test('порядок стабильный: сортировка по имени, без зависимости от файловой системы', () => {
    const plan = planSync({ pages: { 'b.md': 'x', 'A.md': 'y', 'c.md': 'z' }, existing: {} });

    assert.deepEqual(plan.write, ['A.md', 'b.md', 'c.md']);
  });

  test('пустые входы не ломают план', () => {
    assert.deepEqual(planSync(), { write: [], remove: [], unchanged: [] });
    assert.deepEqual(planSync({ pages: {}, existing: {} }), {
      write: [],
      remove: [],
      unchanged: [],
    });
  });
});

describe('readPages: страницы из каталога', () => {
  test('читает только markdown, остальное не публикуется случайно', () => {
    const dir = pages({
      'Home.md': '# Главная',
      '_Sidebar.md': '- пункт',
      'notes.txt': 'не страница',
    });
    const read = readPages(dir);

    assert.deepEqual(Object.keys(read).sort(), ['Home.md', '_Sidebar.md']);
    assert.equal(read['Home.md'], '# Главная');
  });

  test('нет каталога — нет страниц, без исключения', () => {
    assert.deepEqual(readPages(join(tmpdir(), 'wiki-no-such-dir-' + Date.now())), {});
  });
});

describe('repoSlugFromRemote: owner/repo из адреса', () => {
  test('формы адресов приводятся к одному слагу', () => {
    const forms = [
      'https://github.com/DNikulshin/dev-harness.git',
      'https://github.com/DNikulshin/dev-harness',
      'git@github.com:DNikulshin/dev-harness.git',
      'ssh://git@github.com/DNikulshin/dev-harness.git',
      'DNikulshin/dev-harness',
    ];

    for (const form of forms) {
      assert.equal(repoSlugFromRemote(form), 'DNikulshin/dev-harness', form);
    }
  });

  test('лишние сегменты пути не ломают разбор', () => {
    assert.equal(repoSlugFromRemote('https://github.com/owner/repo.git/'), 'owner/repo');
  });

  test('мусор — null, а не догадка', () => {
    assert.equal(repoSlugFromRemote(''), null);
    assert.equal(repoSlugFromRemote('origin'), null);
    assert.equal(repoSlugFromRemote(undefined), null);
    assert.equal(repoSlugFromRemote(42), null);
  });
});
