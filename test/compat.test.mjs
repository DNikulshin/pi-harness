/**
 * Тесты сверки версий (`src/compat.mjs`).
 *
 * Диапазон объявляем мы сами, поэтому проверяется ровно то, что поддержано: `^`, `~`, `>=`, точная
 * версия и поведение `^` в 0.x, где минор ломает совместимость. Неизвестная форма — отказ, а не
 * «считаем совместимым».
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  checkCompatibility,
  compareVersions,
  parseRange,
  parseVersion,
  satisfies,
} from '../src/compat.mjs';

describe('parseVersion', () => {
  test('читает X.Y.Z и отбрасывает предрелиз в отдельное поле', () => {
    assert.deepEqual(parseVersion('0.2.0'), { major: 0, minor: 2, patch: 0, prerelease: null });
    assert.deepEqual(parseVersion('1.10.3-rc.1'), {
      major: 1,
      minor: 10,
      patch: 3,
      prerelease: 'rc.1',
    });
  });

  test('не версия — null, а не исключение: вызывающая сторона решает, как отказать', () => {
    for (const text of ['', 'v1.2.3', '1.2', '1.2.3.4', 'latest', '^1.2.3']) {
      assert.equal(parseVersion(text), null, `"${text}" не должен считаться версией`);
    }
  });
});

describe('compareVersions', () => {
  test('сравнивает по числам, а не по строкам: 1.10 > 1.9', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
    assert.equal(compareVersions('0.1.9', '0.2.0'), -1);
  });

  test('предрелиз не мешает числовому сравнению', () => {
    assert.equal(compareVersions('0.2.0-rc.1', '0.2.0'), 0);
  });

  test('не версия — исключение: тихо возвращать 0 нельзя', () => {
    assert.throws(() => compareVersions('x', '0.2.0'), /не является версией/u);
  });
});

describe('parseRange', () => {
  test('разбирает поддержанные формы', () => {
    assert.deepEqual(parseRange('^0.2.0'), { kind: 'caret', version: '0.2.0' });
    assert.deepEqual(parseRange('~0.2.3'), { kind: 'tilde', version: '0.2.3' });
    assert.deepEqual(parseRange('>=1.0.0'), { kind: 'gte', version: '1.0.0' });
    assert.deepEqual(parseRange('0.2.0'), { kind: 'exact', version: '0.2.0' });
  });

  test('неподдержанная форма — отказ с текстом диапазона', () => {
    for (const text of ['*', '0.2.0 || 0.3.0', '>=0.2.0 <0.3.0', '']) {
      assert.throws(() => parseRange(text), RangeError, `"${text}" должен быть отвергнут`);
    }
  });
});

describe('satisfies', () => {
  /** @type {ReadonlyArray<{version: string, range: string, expected: boolean}>} */
  const cases = [
    { version: '0.2.0', range: '^0.2.0', expected: true },
    { version: '0.2.7', range: '^0.2.0', expected: true },
    { version: '0.3.0', range: '^0.2.0', expected: false },
    { version: '0.1.9', range: '^0.2.0', expected: false },
    { version: '0.0.3', range: '^0.0.3', expected: true },
    { version: '0.0.4', range: '^0.0.3', expected: false },
    { version: '1.9.0', range: '^1.2.3', expected: true },
    { version: '2.0.0', range: '^1.2.3', expected: false },
    { version: '0.2.9', range: '~0.2.3', expected: true },
    { version: '0.3.0', range: '~0.2.3', expected: false },
    { version: '0.2.2', range: '~0.2.3', expected: false },
    { version: '3.0.0', range: '>=1.0.0', expected: true },
    { version: '0.9.0', range: '>=1.0.0', expected: false },
    { version: '0.2.0', range: '0.2.0', expected: true },
    { version: '0.2.1', range: '0.2.0', expected: false },
  ];

  for (const { version, range, expected } of cases) {
    test(`${version} в ${range} — ${expected ? 'совместимо' : 'нет'}`, () => {
      assert.equal(satisfies(version, parseRange(range)), expected);
    });
  }
});

describe('checkCompatibility: текст для человека', () => {
  test('совместимо — сообщение с обеими сторонами', () => {
    const result = checkCompatibility({ coreVersion: '0.2.0', range: '^0.2.0' });

    assert.equal(result.ok, true);
    assert.match(result.message, /0\.2\.0/u);
    assert.match(result.message, /\^0\.2\.0/u);
  });

  test('ядро не установлено — подсказка команды установки', () => {
    const result = checkCompatibility({ coreVersion: null, range: '^0.2.0' });

    assert.equal(result.ok, false);
    assert.match(result.message, /не установлено/u);
    assert.match(result.message, /npm i -D @dnikulshin\/harness/u);
  });

  test('версия вне диапазона — обе версии в тексте', () => {
    const result = checkCompatibility({ coreVersion: '0.3.1', range: '^0.2.0' });

    assert.equal(result.ok, false);
    assert.match(result.message, /0\.3\.1/u, 'должна быть установленная версия');
    assert.match(result.message, /\^0\.2\.0/u, 'должен быть требуемый диапазон');
  });

  test('версия нечитаемая — отказ, а не «наверное совместимо»', () => {
    const result = checkCompatibility({ coreVersion: 'v0.2.0', range: '^0.2.0' });

    assert.equal(result.ok, false);
    assert.match(result.message, /не читается/u);
  });
});
