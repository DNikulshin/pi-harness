/**
 * Граница с ядром: адаптер не импортирует его внутренности (ADR 0004/0008 ядра).
 *
 * Проверка по исходникам, а не по обещанию: `scripts/**` и `scripts/lib/**` ядра закрыты, и
 * единственные легальные обращения — `bin`-команды, `package.json` и файлы `.pi/`. Тест читает
 * файлы, поэтому не требует установленного ядра.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_DIRS = ['src', 'scripts', 'test'];

/**
 * Все `.mjs` в каталогах исходников.
 * @param {string} dir каталог от корня пакета
 * @returns {string[]} пути
 */
function sources(dir) {
  const full = join(ROOT, dir);
  const result = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...sources(join(dir, entry.name)));
    else if (entry.name.endsWith('.mjs')) result.push(join(dir, entry.name));
  }

  return result;
}

const FILES = SOURCE_DIRS.flatMap(sources);

describe('импорты ядра', () => {
  test('в исходниках есть что проверять', () => {
    assert.ok(FILES.length >= 4, `ожидались исходники, получено ${FILES.length}`);
  });

  test('ни одного импорта @dnikulshin/harness — ни scripts/, ни scripts/lib/', () => {
    const offenders = [];
    for (const file of FILES) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      // Любой импорт ядра запрещён: контракт — bin и файлы, а не модули.
      for (const match of text.matchAll(
        /(?:from\s+|import\()\s*['"](@dnikulshin\/harness[^'"]*)['"]/gu,
      )) {
        offenders.push(`${file}: ${match[1]}`);
      }
    }

    assert.deepEqual(offenders, [], `импорт внутренностей ядра запрещён: ${offenders.join(', ')}`);
  });

  test('ядро упоминается только как имя пакета и пути артефактов', () => {
    // Страховка от «почти легальных» путей: чтение scripts/** через путь, а не импорт.
    const offenders = [];
    for (const file of FILES) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const match of text.matchAll(/['"]@dnikulshin\/harness\/[^'"]*['"]/gu)) {
        if (match[0].includes('/package.json')) continue;
        offenders.push(`${file}: ${match[0]}`);
      }
    }

    assert.deepEqual(offenders, [], `обращение к путям пакета запрещено: ${offenders.join(', ')}`);
  });
});
