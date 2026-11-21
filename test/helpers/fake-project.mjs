/**
 * Временный проект с поддельным `bin` ядра.
 *
 * Нужен, чтобы тесты адаптера не требовали живого ядра и настоящего цикла: `bin`
 * `harness-cycle-driver` объявлен в ядре, поэтому тест подставляет свой файл по тому же пути и
 * отдаёт заранее заготовленные ответы по очереди. Адаптер запускает его через `node`, так что
 * бит исполнения не нужен и платформа не важна.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Ответ поддельного драйвера: что напечатать и с каким кодом выйти. */
/** @typedef {{out: unknown, code?: number, err?: string}} FakeResponse */

const FAKE_BIN = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const queueFile = join(dir, 'queue.json');
const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
const entry = queue.shift() ?? { out: null, code: 2, err: 'поддельный драйвер: очередь ответов пуста' };
writeFileSync(queueFile, JSON.stringify(queue));
if (entry.out !== null && entry.out !== undefined) {
  process.stdout.write(typeof entry.out === 'string' ? entry.out : JSON.stringify(entry.out));
}
if (entry.err) process.stderr.write(entry.err);
process.exit(entry.code ?? 0);
`;

/** Созданные каталоги: убираются после теста. @type {string[]} */
export const created = [];

/**
 * Убрать все созданные проекты.
 * @returns {void}
 */
export function cleanup() {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Проект с установленным (по файлам) ядром и поддельным драйвером.
 * @param {object} [options] параметры
 * @param {string} [options.coreVersion] версия ядра для `package.json`
 * @param {FakeResponse[]} [options.responses] очередь ответов драйвера
 * @returns {string} путь проекта
 */
export function fakeProject({ coreVersion = '0.2.0', responses = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-harness-project-'));
  created.push(root);

  const core = join(root, 'node_modules', '@dnikulshin', 'harness');
  mkdirSync(core, { recursive: true });
  writeFileSync(
    join(core, 'package.json'),
    JSON.stringify({ name: '@dnikulshin/harness', version: coreVersion }),
  );
  mkdirSync(join(root, '.pi'), { recursive: true });

  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'harness-cycle-driver'), FAKE_BIN);
  writeFileSync(join(bin, 'queue.json'), JSON.stringify(responses));

  return root;
}

/**
 * Ответ поддельного драйвера для `next` по контракту `cycle-driver.next/1`.
 * @param {object} [overrides] поля поверх умолчаний
 * @returns {Record<string, unknown>} объект ответа
 */
export function nextResponse(overrides = {}) {
  return {
    contract: 'cycle-driver.next/1',
    stage: 'PLAN',
    status: 'running',
    action: 'run',
    step: 'plan',
    reason: 'plan_missing',
    target: null,
    waiting_for: null,
    commands: ['node scripts/cycle-state.mjs show'],
    cycle: {
      issue: 12,
      branch: 'feat/12-x',
      dir: '.pi/artifacts/x',
      iteration: 1,
      max_iterations: 3,
      stage: 'PLAN',
      stage_status: 'running',
      owner_approved: null,
      escalation: null,
    },
    done: {
      stages: [
        { stage: 'INIT', iteration: 1, status: 'done', finished_at: '2026-11-21T00:00:00Z' },
      ],
      driver: null,
    },
    ...overrides,
  };
}

/**
 * Ответ поддельного драйвера для `run` с исполненной командой.
 * @param {object} [overrides] поля поверх умолчаний
 * @returns {Record<string, unknown>} объект ответа
 */
export function runResponse(overrides = {}) {
  return {
    driver: 'run',
    dir: '.pi/artifacts/x',
    executed: [
      {
        command: 'node scripts/cycle-state.mjs finish --stage PLAN --status done',
        code: 0,
        output: 'ok',
      },
    ],
    ...overrides,
  };
}
