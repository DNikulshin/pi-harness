/**
 * Тесты контракта архива и настоящего `npm pack`.
 *
 * Проверка, которая не краснеет на сломанном архиве, ничего не доказывает: она стоит между
 * сборкой и публикацией, а версию в npm нельзя перезаписать. Поэтому правила проверяются на
 * синтетических списках (быстро и точно), а один тест собирает настоящий архив и убеждается, что
 * текущий `package.json` проходит собственные требования — иначе релиз упадёт на шаге, который мы
 * могли проверить локально.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgs, readArchive, checkArchive } from '../tooling/check-package.mjs';
import {
  REQUIRED_ENTRIES,
  archiveProblems,
  normalizeRepository,
  parseVerboseListing,
  versionFromTag,
} from '../tooling/package-contract.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Полный манифест пакета, который проходит проверки. */
const MANIFEST = {
  name: '@dnikulshin/pi-harness',
  version: '0.1.0',
  private: false,
  files: ['src/', 'scripts/', 'types/', 'CHANGELOG.md', 'LICENSE', 'README.md'],
  bin: { 'pi-harness-check': './scripts/check-core.mjs' },
  exports: {
    '.': { types: './types/extension.d.mts', default: './src/extension.mjs' },
    './compat': { types: './types/compat.d.mts', default: './src/compat.mjs' },
  },
  peerDependencies: { '@dnikulshin/harness': '^0.2.0' },
};

/**
 * Режимы «как в архиве»: исполняемый для bin, обычный для остальных.
 * @param {string[]} entries имена файлов
 * @returns {Record<string, string>} режимы
 */
function modesFor(entries) {
  /** @type {Record<string, string>} */
  const modes = {};
  for (const entry of entries) {
    modes[entry] =
      entry.endsWith('.mjs') || entry.endsWith('check-core.mjs')
        ? entry === 'scripts/check-core.mjs'
          ? '-rwxr-xr-x'
          : '-rw-r--r--'
        : '-rw-r--r--';
  }

  return modes;
}

/**
 * Находки для набора записей с подменённым манифестом.
 * @param {string[]} entries записи архива
 * @param {Record<string, any>} [manifest] манифест
 * @param {string | null} [tag] тег
 * @returns {string[]} находки
 */
function problems(entries, manifest = MANIFEST, tag = null) {
  return archiveProblems({ entries, modes: modesFor(entries), manifest, tag });
}

describe('archiveProblems: обязательный состав', () => {
  test('полный архив находок не даёт', () => {
    assert.deepEqual(problems([...REQUIRED_ENTRIES]), []);
  });

  test('каждый обязательный файл проверяется отдельно', () => {
    for (const required of REQUIRED_ENTRIES) {
      const entries = REQUIRED_ENTRIES.filter((entry) => entry !== required);
      const found = problems(entries);

      assert.ok(
        found.includes(`нет обязательного файла: ${required}`),
        `пропажа ${required} должна ловиться, получено: ${found.join('; ') || '(пусто)'}`,
      );
      // Пропажа файла из `files` законно тянет и находку про покрытие: проверяем только главное.
      assert.ok(found.length <= 3, `слишком много находок на один файл: ${found.join('; ')}`);
    }
  });

  test('тесты и CI в архиве — находка, а не мелочь', () => {
    const entries = [...REQUIRED_ENTRIES, 'test/consumer.test.mjs', '.github/workflows/ci.yml'];

    assert.deepEqual(problems(entries), [
      'в архиве лишнее: test/consumer.test.mjs',
      'в архиве лишнее: .github/workflows/ci.yml',
    ]);
  });
});

describe('archiveProblems: обещания package.json', () => {
  test('bin без файла — находка', () => {
    const entries = REQUIRED_ENTRIES.filter((entry) => entry !== 'scripts/check-core.mjs');

    assert.ok(
      problems(entries).includes(
        'bin pi-harness-check указывает на отсутствующий файл: scripts/check-core.mjs',
      ),
    );
  });

  test('bin без бита исполнения — находка: npx ответит 126/127', () => {
    const modes = modesFor([...REQUIRED_ENTRIES]);
    modes['scripts/check-core.mjs'] = '-rw-r--r--';

    const found = archiveProblems({ entries: [...REQUIRED_ENTRIES], modes, manifest: MANIFEST });
    assert.ok(found.some((problem) => problem.includes('без бита исполнения')));
  });

  test('цель exports без файла — находка', () => {
    const entries = REQUIRED_ENTRIES.filter(
      (entry) => entry !== 'types/auth'.replace('auth', 'compat.d.mts'),
    );

    assert.ok(problems(entries).some((problem) => problem.includes('exports["./compat (types)"]')));
  });

  test('files: путь, который ничего не содержит, — находка', () => {
    const manifest = { ...MANIFEST, files: [...MANIFEST.files, 'docs/'] };

    assert.ok(
      problems([...REQUIRED_ENTRIES], manifest).includes('files: путь docs/ ничего не содержит'),
    );
  });

  test('private=true — публикация невозможна', () => {
    assert.ok(
      problems([...REQUIRED_ENTRIES], { ...MANIFEST, private: true }).includes(
        'package.json: private=true — публикация невозможна',
      ),
    );
  });

  test('без peerDependencies на ядро совместимость не объявлена', () => {
    const manifest = { ...MANIFEST, peerDependencies: {} };

    assert.ok(
      problems([...REQUIRED_ENTRIES], manifest).some((problem) =>
        problem.includes('peerDependencies'),
      ),
    );
  });

  test('версия против тега: v0.1.0 против 0.2.0 — находка', () => {
    const found = problems([...REQUIRED_ENTRIES], MANIFEST, 'v0.2.0');

    assert.deepEqual(found, ['версия в архиве 0.1.0 не совпадает с тегом v0.2.0']);
  });

  test('версия против тега: совпадение — тишина', () => {
    assert.deepEqual(problems([...REQUIRED_ENTRIES], MANIFEST, 'v0.1.0'), []);
  });
});

describe('archiveProblems: repository.url против репозитория сборки', () => {
  const manifest = {
    ...MANIFEST,
    repository: { type: 'git', url: 'git+https://github.com/DNikulshin/pi-harness.git' },
  };

  test('совпадает — тишина, хотя форма записи разная', () => {
    assert.deepEqual(
      archiveProblems({
        entries: [...REQUIRED_ENTRIES],
        modes: modesFor([...REQUIRED_ENTRIES]),
        manifest,
        repository: 'DNikulshin/pi-harness',
      }),
      [],
    );
  });

  test('нет repository.url — находка: npm ответит E422 на --provenance', () => {
    const found = archiveProblems({
      entries: [...REQUIRED_ENTRIES],
      modes: modesFor([...REQUIRED_ENTRIES]),
      manifest: MANIFEST,
      repository: 'DNikulshin/pi-harness',
    });

    assert.ok(found.some((problem) => problem.includes('нет repository.url')));
  });

  test('чужой репозиторий — находка с обоими адресами', () => {
    const found = archiveProblems({
      entries: [...REQUIRED_ENTRIES],
      modes: modesFor([...REQUIRED_ENTRIES]),
      manifest,
      repository: 'someone/else',
    });

    assert.ok(
      found.some((problem) => problem.includes('не совпадает с репозиторием сборки someone/else')),
    );
  });

  test('normalizeRepository приводит формы к одному виду', () => {
    const forms = [
      'git+https://github.com/DNikulshin/pi-harness.git',
      'https://github.com/DNikulshin/pi-harness',
      'git@github.com:DNikulshin/pi-harness.git',
      'https://github.com/dnikulshin/pi-harness/',
    ];

    for (const form of forms) {
      assert.equal(normalizeRepository(form), 'https://github.com/dnikulshin/pi-harness', form);
    }
  });
});

describe('parseVerboseListing', () => {
  test('читает имя и режим из вывода tar -tvzf (GNU)', () => {
    const { entries, modes } = parseVerboseListing([
      'drwxr-xr-x user/group 0 2026-11-21 21:00 package/',
      '-rwxr-xr-x user/group 1801 2026-11-21 21:00 package/scripts/check-core.mjs',
      '-rw-r--r-- user/group 54 2026-11-21 21:00 package/package.json',
    ]);

    assert.deepEqual(entries, ['scripts/check-core.mjs', 'package.json']);
    assert.equal(modes['scripts/check-core.mjs'], '-rwxr-xr-x');
  });

  test('формат BSD (macos) разбирается так же: поле nlink лишнее', () => {
    const { entries, modes } = parseVerboseListing([
      '-rw-r--r--  0 user  group     54 Nov 21 21:00 package/package.json',
      '-rwxr-xr-x  0 user  group   1801 Nov 21 21:00 package/scripts/check-core.mjs',
    ]);

    assert.deepEqual(entries, ['package.json', 'scripts/check-core.mjs']);
    assert.equal(modes['package.json'], '-rw-r--r--');
    assert.equal(modes['scripts/check-core.mjs'], '-rwxr-xr-x');
  });
});

describe('versionFromTag', () => {
  test('снимает префикс v', () => {
    assert.equal(versionFromTag('v0.1.0'), '0.1.0');
    assert.equal(versionFromTag('0.1.0'), '0.1.0');
  });
});

describe('parseArgs', () => {
  test('архив обязателен, --tag и --repository отдельными флагами', () => {
    assert.deepEqual(parseArgs(['a.tgz']), { file: 'a.tgz', tag: null, repository: null });
    assert.deepEqual(parseArgs(['a.tgz', '--tag', 'v0.1.0']), {
      file: 'a.tgz',
      tag: 'v0.1.0',
      repository: null,
    });
    assert.deepEqual(parseArgs(['a.tgz', '--repository', 'owner/repo']), {
      file: 'a.tgz',
      tag: null,
      repository: 'owner/repo',
    });
    assert.throws(() => parseArgs([]), /использование/u);
    assert.throws(() => parseArgs(['a.tgz', '--tag']), /--tag: ожидается vX\.Y\.Z/u);
    assert.throws(
      () => parseArgs(['a.tgz', '--repository']),
      /--repository: ожидается owner\/repo/u,
    );
    assert.throws(() => parseArgs(['a.tgz', 'b.tgz']), /лишний аргумент/u);
  });
});

describe('настоящий архив: текущий package.json проходит собственные требования', () => {
  test('npm pack собирает архив без находок', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-harness-pack-'));
    dirs.push(dir);

    execFileSync('npm', ['pack', '--pack-destination', dir, '--silent'], {
      cwd: ROOT,
      stdio: 'pipe',
      maxBuffer: 8 * 1024 * 1024,
    });

    const [archive] = readdirSync(dir).filter((name) => name.endsWith('.tgz'));
    assert.ok(archive !== undefined, 'npm pack не создал архив');

    const file = join(dir, archive);
    const { entries, modes } = readArchive(file);
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', file, 'package/package.json'], { encoding: 'utf8' }),
    );

    assert.deepEqual(
      archiveProblems({ entries, modes, manifest, tag: `v${manifest.version}` }),
      [],
      'собственный архив должен проходить собственные правила',
    );
    assert.deepEqual(checkArchive({ file, tag: `v${manifest.version}` }), []);
  });
});
