/**
 * Тесты чтения состояния ядра (`src/core.mjs`) и расширения (`src/extension.mjs`).
 *
 * Источник правды — файлы: `node_modules/@dnikulshin/harness/package.json` и `.pi/harness.version`.
 * Ядро не импортируется (это проверяет `imports.test.mjs`), поэтому сценарии собираются на
 * временных каталогах.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import extension, { statusLine } from '../src/extension.mjs';
import {
  findProjectRoot,
  readHarnessVersion,
  readInstalledCoreVersion,
  resolveCoreState,
} from '../src/core.mjs';

/** Временный каталог, который убирается после теста. @type {string[]} */
/** @type {string[]} */
/** Временный каталог, который убирается после теста. @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Создать временный каталог проекта.
 * @param {object} [params] что положить в проект
 * @param {string} [params.coreVersion] версия ядра в `node_modules`
 * @param {string} [params.artifact] содержимое `.pi/harness.version`
 * @returns {string} путь проекта
 */
function project({ coreVersion, artifact } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-harness-'));
  dirs.push(root);

  if (coreVersion !== undefined) {
    const core = join(root, 'node_modules', '@dnikulshin', 'harness');
    mkdirSync(core, { recursive: true });
    writeFileSync(
      join(core, 'package.json'),
      JSON.stringify({ name: '@dnikulshin/harness', version: coreVersion }),
    );
  }

  if (typeof artifact === 'string') {
    mkdirSync(join(root, '.pi'), { recursive: true });
    writeFileSync(join(root, '.pi', 'harness.version'), artifact);
  }

  return root;
}

describe('findProjectRoot', () => {
  test('поднимается от вложенного каталога до `.pi/`', () => {
    const root = project({ artifact: '{}' });
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    assert.equal(findProjectRoot(nested), root);
  });

  test('ни `.pi/`, ни `package.json` — null, а не каталог наугад', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pi-harness-empty-'));
    dirs.push(empty);

    assert.equal(findProjectRoot(empty), null);
  });
});

describe('readInstalledCoreVersion', () => {
  test('читает версию из package.json установленного ядра', () => {
    const root = project({});

    assert.equal(readInstalledCoreVersion(root), null, 'без node_modules — null');

    const withCore = project({ coreVersion: '0.2.0' });
    assert.equal(readInstalledCoreVersion(withCore), '0.2.0');
  });

  test('битый package.json ядра — null, а не исключение', () => {
    const root = project({});
    const core = join(root, 'node_modules', '@dnikulshin', 'harness');
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, 'package.json'), '{ oops');

    assert.equal(readInstalledCoreVersion(root), null);
  });
});

describe('readHarnessVersion', () => {
  test('нет файла — null: шаблоны не ставились', () => {
    assert.equal(readHarnessVersion(project({})), null);
  });

  test('читает версию и дайджесты', () => {
    const root = project({
      artifact: JSON.stringify({ version: '0.2.0', templates: { 'a.md': 'abc' } }),
    });

    assert.deepEqual(readHarnessVersion(root), {
      version: '0.2.0',
      templates: { 'a.md': 'abc' },
      error: null,
    });
  });

  test('битый файл — запись с ошибкой, а не падение: адаптер сообщит и продолжит', () => {
    const root = project({ artifact: '{ битый' });
    const parsed = readHarnessVersion(root);

    assert.equal(parsed?.version, null);
    assert.ok(typeof parsed?.error === 'string' && parsed.error.length > 0);
  });
});

describe('resolveCoreState', () => {
  test('установленная версия и версия шаблонов совпадают — drift нет', () => {
    const root = project({ coreVersion: '0.2.0', artifact: JSON.stringify({ version: '0.2.0' }) });
    const state = resolveCoreState({ cwd: root });

    assert.equal(state.root, root);
    assert.equal(state.installedVersion, '0.2.0');
    assert.equal(state.artifactVersion, '0.2.0');
    assert.equal(state.drift, false);
  });

  test('ядро обновили без переустановки шаблонов — drift', () => {
    const root = project({ coreVersion: '0.2.2', artifact: JSON.stringify({ version: '0.2.0' }) });

    assert.equal(resolveCoreState({ cwd: root }).drift, true);
  });

  test('нет neither ядра nor шаблонов — пустые поля, без исключений', () => {
    const root = project({});
    const state = resolveCoreState({ cwd: root });

    assert.deepEqual(
      {
        installedVersion: state.installedVersion,
        artifactVersion: state.artifactVersion,
        drift: state.drift,
      },
      { installedVersion: null, artifactVersion: null, drift: false },
    );
  });
});

describe('statusLine', () => {
  test('показывает корень, ядро и шаблоны', () => {
    const root = project({ coreVersion: '0.2.0', artifact: JSON.stringify({ version: '0.2.0' }) });
    const line = statusLine(resolveCoreState({ cwd: root }));

    assert.match(line, /ядро: 0\.2\.0/u);
    assert.match(line, /шаблоны: 0\.2\.0/u);
  });

  test('корня нет — просьба запускать из проекта', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pi-harness-empty-'));
    dirs.push(empty);

    assert.match(statusLine(resolveCoreState({ cwd: empty })), /Корень проекта не найден/u);
  });
});

describe('extension: регистрация /cycle', () => {
  /**
   * Поддельный API Pi: запоминает команды и уведомления.
   * @returns {{pi: any, commands: Map<string, any>, notices: Array<[string, string]>}} фейк
   */
  function fakePi() {
    /** @type {Map<string, any>} */
    const commands = new Map();
    /** @type {Array<[string, string]>} */
    const notices = [];

    return {
      pi: {
        /** @param {string} name @param {any} options */
        registerCommand: (name, options) => commands.set(name, options),
      },
      commands,
      notices,
    };
  }

  test('регистрирует команду cycle', () => {
    const { pi, commands } = fakePi();
    extension(pi);

    assert.ok(commands.has('cycle'), 'команда /cycle должна быть зарегистрирована');
    assert.match(commands.get('cycle').description, /Цикл ядра/u);
    assert.match(commands.get('cycle').description, /шаг/u);
  });

  test('несовместимое ядро — ошибка в уведомлении и цикл не начинается', async () => {
    const { pi, commands, notices } = fakePi();
    extension(pi);

    const root = project({ coreVersion: '0.9.0', artifact: JSON.stringify({ version: '0.2.0' }) });
    const cwd = process.cwd();
    process.chdir(root);
    try {
      /** @param {string} text текст @param {string} level уровень */
      const notify = (text, level) => notices.push([level, text]);
      await commands.get('cycle').handler('', { ui: { notify } });
    } finally {
      process.chdir(cwd);
    }

    const levels = notices.map(([level]) => level);
    assert.ok(levels.includes('error'), 'должно быть уведомление уровня error');
    // Первым идёт статус (его тоже помечаем ошибкой), затем — причина отказа.
    const errors = notices
      .filter(([level]) => level === 'error')
      .map(([, text]) => text)
      .join('\n');
    assert.match(errors, /0\.9\.0/u, 'в отказе должна быть установленная версия');
    assert.match(errors, /\^0\.2\.0/u, 'в отказе должен быть требуемый диапазон');
  });
});
