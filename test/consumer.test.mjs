/**
 * Сквозной прогон на ядре **из реестра** (issue #5).
 *
 * Что проверяется, чего не видят тесты на поддельном `bin`: установка настоящего пакета,
 * `harness-init` (`.pi/harness.version` и шаблоны), настоящий `cycle-state init`, настоящий JSON
 * `cycle-driver next` и живой `run` до первой остановки.
 *
 * Тест сетевой и поэтому **выключен по умолчанию**: включается `PI_HARNESS_E2E=1`
 * (`npm run test:e2e`), а спецификацию ядра можно подменить — `PI_HARNESS_CORE_SPEC`. Так CI на PR
 * держит закреплённую версию (красный = наша ошибка), а ночной прогон берёт `latest` (красный =
 * дрейф контракта в ядре).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';

import { checkCompatibility } from '../src/compat.mjs';
import { resolveCoreState } from '../src/core.mjs';
import {
  STOP_ACTIONS,
  SUPPORTED_CONTRACT,
  callDriver,
  describePlan,
  parseStepPlan,
} from '../src/driver.mjs';
import { runCycle } from '../src/run.mjs';
import {
  createConsumer,
  fakeCoreVersion,
  pinnedCoreSpec,
  removeConsumer,
  writeVersionArtifact,
} from '../test-support/consumer.mjs';

const exec = promisify(execFile);
const ENABLED = process.env.PI_HARNESS_E2E === '1';
const SPEC = process.env.PI_HARNESS_CORE_SPEC ?? pinnedCoreSpec();

describe(
  'E2E: проект потребителя на ядре из реестра',
  { skip: ENABLED ? false : 'выключено: PI_HARNESS_E2E=1' },
  () => {
    /** @type {Awaited<ReturnType<typeof createConsumer>>} */
    let consumer;

    before(
      async () => {
        consumer = await createConsumer({ spec: SPEC });
      },
      { timeout: 300_000 },
    );

    after(() => {
      if (consumer !== undefined) removeConsumer(consumer.root);
    });

    test('ядро установлено, шаблоны поставлены, версии совпадают', () => {
      const artifact = JSON.parse(
        readFileSync(join(consumer.root, '.pi', 'harness.version'), 'utf8'),
      );
      const state = resolveCoreState({ cwd: consumer.root });

      assert.equal(state.installedVersion, consumer.coreVersion, 'версия из node_modules');
      assert.equal(artifact.version, consumer.coreVersion, 'версия в .pi/harness.version');
      assert.equal(state.drift, false, 'расхождения быть не должно сразу после init');
      assert.equal(state.artifactError, null);
      assert.ok(state.root === consumer.root, 'корень проекта найден');
    });

    test('совместимость подтверждается своим же диапазоном', () => {
      const range = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
        .peerDependencies['@dnikulshin/harness'];
      const result = checkCompatibility({ coreVersion: consumer.coreVersion, range });

      assert.equal(result.ok, true, result.message);
    });

    test('next отдаёт шаг по контракту и настоящий каталог цикла', async () => {
      const result = await callDriver({ root: consumer.root, args: ['next'] });
      assert.equal(result.code, 0, result.stderr);

      const plan = parseStepPlan(result.json);
      assert.equal(plan.contract, SUPPORTED_CONTRACT);
      assert.equal(plan.stage, 'INIT', 'свежий цикл начинается с INIT');
      assert.equal(plan.action, 'run', 'первый шаг детерминированный');
      assert.ok(readdirSync(consumer.cycleDir).length > 0, 'каталог цикла не пуст');

      const text = describePlan(plan);
      assert.match(text, /Стадия INIT/u);
      assert.match(text, /Команда:/u, 'next должен предлагать готовую команду');
    });

    test('run исполняет шаги и останавливается там, где нужен человек', async () => {
      const stateBefore = JSON.parse(readFileSync(join(consumer.cycleDir, 'state.json'), 'utf8'));
      /** @type {Array<{text: string, level: string}>} */
      const notices = [];

      const report = await runCycle({
        next: () => callDriver({ root: consumer.root, args: ['next'] }),
        runOne: () => callDriver({ root: consumer.root, args: ['run', '--max-steps', '1'] }),
        confirm: async () => true,
        /** @param {string} text @param {string} level */
        notify: (text, level) => notices.push({ text, level }),
        maxSteps: 5,
      });

      assert.ok(
        report.steps >= 1,
        `ожидался хотя бы один шаг: ${notices.map((n) => n.text).join(' | ')}`,
      );
      assert.equal(
        report.stopped,
        'spawn',
        'свежий цикл доходит до PLAN, где нужна модель: дальше адаптер не идёт',
      );
      assert.ok(STOP_ACTIONS.has(report.stopped));

      const stateAfter = JSON.parse(readFileSync(join(consumer.cycleDir, 'state.json'), 'utf8'));
      assert.notEqual(stateAfter.stage, stateBefore.stage, 'стадия сдвинулась: INIT → PLAN');
      assert.equal(stateAfter.stage, 'PLAN');
      assert.ok(
        existsSync(join(consumer.cycleDir, 'evidence', 'criteria.md')),
        'шаг criteria написал критерии в evidence/',
      );
      assert.ok(
        existsSync(join(consumer.cycleDir, 'evidence', 'issue.md')),
        'снимок issue перенесён в evidence/',
      );
      assert.ok(existsSync(join(consumer.cycleDir, 'driver.jsonl')), 'драйвер ведёт журнал');
    });

    test('версия вне диапазона — отказ с обоими номерами, код 1', async () => {
      fakeCoreVersion(consumer.root, '0.9.0');
      try {
        const script = fileURLToPath(new URL('../scripts/check-core.mjs', import.meta.url));
        const failure = await exec(process.execPath, [script], { cwd: consumer.root }).then(
          () => null,
          (error) => error,
        );

        assert.ok(failure !== null, 'проверка должна отказать при версии вне диапазона');
        assert.equal(failure.code, 1);
        const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
        assert.match(output, /0\.9\.0/u, 'в отказе установленная версия');
        assert.match(output, /\^0\.2\./u, 'в отказе требуемый диапазон');
      } finally {
        fakeCoreVersion(consumer.root, consumer.coreVersion);
      }
    });

    test('«ядро обновили, шаблоны — нет» — предупреждение, а не отказ', () => {
      writeVersionArtifact(consumer.root, '0.0.1');
      try {
        const state = resolveCoreState({ cwd: consumer.root });

        assert.equal(state.drift, true, 'расхождение видно');
        assert.equal(state.installedVersion, consumer.coreVersion, 'ядро читается по node_modules');
        assert.equal(state.artifactVersion, '0.0.1');
      } finally {
        writeVersionArtifact(consumer.root, consumer.coreVersion);
      }
    });
  },
);
