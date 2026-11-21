/**
 * Тесты релизного workflow: порядок шагов и путь публикации.
 *
 * Проверка, которая падает уже после теста и сборки, стоит прогона релиза, а версия в npm
 * неизменяема: тег `v0.1.0` так и не опубликовал ничего — `npm pack --pack-destination dist`
 * требует существующий каталог `dist/`, а в чистом checkout его нет (локально он был создан руками,
 * поэтому ошибка не воспроизводилась).
 *
 * Тест читает сам `.github/workflows/release.yml`: правило живёт в YAML, а не в коде, и без теста
 * оно тихо разъезжается с замыслом.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
/** Исполняемые строки: комментарии обсуждают команды и мешали бы сравнению. */
const LINES = WORKFLOW.split('\n').filter((line) => !line.trim().startsWith('#'));

/**
 * Позиция первой строки, содержащей фрагмент.
 * @param {string} needle искомый фрагмент
 * @returns {number} индекс или -1
 */
function indexOf(needle) {
  return LINES.findIndex((line) => line.includes(needle));
}

describe('release.yml: сборка архива', () => {
  test('каталог dist создаётся до npm pack', () => {
    const mkdir = indexOf('mkdir -p dist');
    const pack = indexOf('npm pack --pack-destination dist');

    assert.ok(mkdir !== -1, 'нет mkdir -p dist: npm pack упадёт с ENOENT на чистом checkout');
    assert.ok(pack !== -1, 'нет шага npm pack');
    assert.ok(mkdir < pack, 'mkdir должен идти до npm pack');
  });

  test('проверка состава стоит между сборкой и публикацией', () => {
    const pack = indexOf('npm pack');
    const check = indexOf('tooling/check-package.mjs');
    const publish = indexOf('npm publish');

    assert.ok(pack < check, 'проверка состава должна идти после сборки');
    assert.ok(check < publish, 'проверка состава должна идти до публикации');
  });

  test('публикуется файл архива, а не каталог: путь с ./', () => {
    const publish = LINES.find((line) => line.includes('npm publish')) ?? '';

    assert.match(
      publish,
      /npm publish \.\/dist\/\*\.tgz/u,
      'без ./ npm разбирает путь как owner/repo и уходит в git ls-remote',
    );
    assert.match(publish, /--provenance/u);
    assert.match(publish, /--access public/u);
  });

  test('версия сверяется с тегом', () => {
    assert.match(WORKFLOW, /--tag "\$GITHUB_REF_NAME"/u);
  });
});

describe('release.yml: авторизация', () => {
  test('гейт «секрет задан» стоит до установки зависимостей и публикации', () => {
    const guard = indexOf('NPM_TOKEN не задан');
    const install = indexOf('npm ci');
    const publish = indexOf('npm publish');

    assert.ok(guard !== -1, 'нет гейта на пустой NPM_TOKEN');
    assert.ok(guard < install, 'гейт должен идти до npm ci');
    assert.ok(guard < publish, 'гейт должен идти до публикации');
  });

  test('публикация получает токен из секрета', () => {
    assert.match(WORKFLOW, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/u);
  });

  test('provenance требует id-token: write', () => {
    assert.match(WORKFLOW, /id-token: write/u);
  });
});
