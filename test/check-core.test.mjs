/**
 * Контракт CLI `pi-harness-check`: код возврата и текст.
 *
 * ADR 0008 ядра требует, чтобы несовместимая версия давала отказ с обоими номерами. Проверяется
 * процессом, а не функцией: код возврата — это то, на что опирается CI потребителя.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/check-core.mjs', import.meta.url));

/** @type {string[]} */
/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Проект с установленным ядром.
 * @param {string | null} [version] версия ядра (`null` — не устанавливать)
 * @returns {string} путь проекта
 */
function project(version) {
  const root = mkdtempSync(join(tmpdir(), 'pi-harness-cli-'));
  dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'consumer' }));

  if (version !== null) {
    const core = join(root, 'node_modules', '@dnikulshin', 'harness');
    mkdirSync(core, { recursive: true });
    writeFileSync(
      join(core, 'package.json'),
      JSON.stringify({ name: '@dnikulshin/harness', version }),
    );
  }

  return root;
}

/**
 * Запуск проверки в каталоге проекта.
 * @param {string} cwd каталог проекта
 * @returns {Promise<{code: number, out: string}>} код возврата и объединённый вывод
 */
async function check(cwd) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT], { cwd });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    const failed = /** @type {{code?: number, stdout?: string, stderr?: string}} */ (error);
    return { code: failed.code ?? -1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

describe('pi-harness-check', () => {
  test('совместимое ядро — код 0 и обе стороны в тексте', async () => {
    const { code, out } = await check(project('0.2.0'));

    assert.equal(code, 0, out);
    assert.match(out, /0\.2\.0/u);
    assert.match(out, /\^0\.2\.0/u);
  });

  test('несовместимое ядро — код 1 и обе версии в тексте', async () => {
    const { code, out } = await check(project('0.9.0'));

    assert.equal(code, 1, out);
    assert.match(out, /0\.9\.0/u);
    assert.match(out, /\^0\.2\.0/u);
  });

  test('ядро не установлено — код 1 и подсказка установки', async () => {
    const { code, out } = await check(project(null));

    assert.equal(code, 1, out);
    assert.match(out, /не установлено/u);
  });
});
