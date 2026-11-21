/**
 * Тесты слоя драйвера (`src/driver.mjs`): контракт, подтверждения, текст для человека и запуск
 * поддельного `bin`.
 *
 * Ядро не требуется: поддельный `harness-cycle-driver` кладётся в `node_modules/.bin` временного
 * проекта, адаптер запускает его так же, как настоящее ядро.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  EXECUTABLE_ACTIONS,
  STOP_ACTIONS,
  SUPPORTED_CONTRACT,
  callDriver,
  describePlan,
  driverPath,
  needsConfirmation,
  parseStepPlan,
} from '../src/driver.mjs';
import { cleanup, fakeProject, nextResponse } from './helpers/fake-project.mjs';

after(cleanup);

/**
 * План шага из ответа по контракту.
 * @param {object} [overrides] поля поверх умолчаний
 * @returns {import('../src/driver.mjs').StepPlan} план
 */
function plan(overrides = {}) {
  return parseStepPlan(nextResponse(overrides));
}

describe('parseStepPlan: контракт cycle-driver.next/1', () => {
  test('разбирает штатный ответ', () => {
    const parsed = plan();

    assert.equal(parsed.contract, SUPPORTED_CONTRACT);
    assert.equal(parsed.action, 'run');
    assert.equal(parsed.stage, 'PLAN');
    assert.equal(parsed.step, 'plan');
    assert.deepEqual(parsed.commands, ['node scripts/cycle-state.mjs show']);
  });

  test('чужая версия формы — отказ, а не угадывание', () => {
    assert.throws(
      () => plan({ contract: 'cycle-driver.next/2' }),
      /не поддержан: адаптер понимает cycle-driver\.next\/1/u,
    );
  });

  test('ответ без contract — тоже отказ', () => {
    const response = nextResponse();
    delete (/** @type {Record<string, unknown>} */ (response).contract);

    assert.throws(() => parseStepPlan(response), /\(нет поля contract\)/u);
  });

  test('неизвестное действие — отказ со значением', () => {
    assert.throws(() => plan({ action: 'teleport' }), /неизвестное действие драйвера: teleport/u);
  });

  test('отсутствующее действие — отказ', () => {
    const response = nextResponse();
    delete (/** @type {Record<string, unknown>} */ (response).action);

    assert.throws(() => parseStepPlan(response), /нет поля action/u);
  });

  test('не JSON или не объект — отказ с подсказкой про контракт', () => {
    for (const value of [null, 'строка', 42]) {
      assert.throws(() => parseStepPlan(value), /драйвер вернул не JSON/u);
    }
  });

  test('необязательные поля заполняются безопасными умолчаниями', () => {
    const parsed = plan({ target: undefined, waiting_for: undefined, commands: undefined });

    assert.equal(parsed.target, null);
    assert.equal(parsed.waitingFor, null);
    assert.deepEqual(parsed.commands, []);
  });

  test('действия делятся на исполняемые и остановки без пересечений', () => {
    assert.deepEqual([...EXECUTABLE_ACTIONS], ['run', 'advance', 'finish']);
    assert.deepEqual([...STOP_ACTIONS], ['spawn', 'handoff', 'stop', 'blocked']);
    for (const action of EXECUTABLE_ACTIONS) assert.ok(!STOP_ACTIONS.has(action));
  });
});

describe('needsConfirmation: подтверждение владельца', () => {
  test('вход в PR — подтверждение нужно', () => {
    assert.equal(needsConfirmation(plan({ action: 'advance', target: 'PR' })), true);
  });

  test('вход в ESCALATED — подтверждение нужно', () => {
    assert.equal(needsConfirmation(plan({ action: 'advance', target: 'ESCALATED' })), true);
  });

  test('обычный шаг — подтверждение не нужно', () => {
    assert.equal(needsConfirmation(plan({ action: 'advance', target: 'CODE' })), false);
  });

  test('blocked — остановка, а не переход: подтверждение не нужно', () => {
    assert.equal(needsConfirmation(plan({ action: 'blocked', target: 'PR' })), false);
  });

  test('эскалация в состоянии цикла — подтверждение нужно даже без смены стадии', () => {
    const escalated = plan({
      action: 'handoff',
      target: null,
      cycle: { stage: 'DECIDE', escalation: { reason: 'budget' } },
    });

    assert.equal(needsConfirmation(escalated), true);
  });

  test('явный null в эскалации — не повод спрашивать', () => {
    assert.equal(needsConfirmation(plan({ cycle: { stage: 'PLAN', escalation: null } })), false);
  });
});

describe('describePlan: что видит человек', () => {
  test('стадия, действие, причина, ожидание, итерация, история и команда', () => {
    const text = describePlan(
      plan({
        action: 'handoff',
        target: null,
        reason: 'code_needed',
        waiting_for: 'супервизор: правки в коде',
      }),
    );

    assert.match(text, /Стадия PLAN \(running\) · шаг plan/u);
    assert.match(text, /Действие: handoff/u);
    assert.match(text, /Причина: code_needed/u);
    assert.match(text, /Ждём: супервизор/u);
    assert.match(text, /Итерация 1 из 3 · ветка feat\/12-x/u);
    assert.match(text, /Сделано: INIT:done/u);
  });

  test('переход показывает цель стрелкой', () => {
    assert.match(
      describePlan(plan({ action: 'advance', target: 'CODE' })),
      /Действие: advance → CODE/u,
    );
  });

  test('blocked не предлагает команду: исполнять нечего', () => {
    const text = describePlan(plan({ action: 'blocked', reason: 'gate_failed' }));

    assert.match(text, /Действие: blocked/u);
    assert.doesNotMatch(text, /Команда:/u);
  });
});

describe('driverPath и callDriver: запуск bin ядра', () => {
  test('нет bin — null, а не исключение', async () => {
    const root = fakeProject({ responses: [] });
    assert.notEqual(driverPath(root), null);

    const empty = fakeProject({ responses: [] });
    const { rmSync } = await import('node:fs');
    rmSync(`${empty}/node_modules/.bin`, { recursive: true, force: true });
    assert.equal(driverPath(empty), null);
  });

  test('без bin вызов драйвера — понятная ошибка, а не ENOENT', async () => {
    const root = fakeProject({ responses: [] });
    const { rmSync } = await import('node:fs');
    rmSync(`${root}/node_modules/.bin`, { recursive: true, force: true });

    await assert.rejects(
      () => callDriver({ root, args: ['next'] }),
      /bin harness-cycle-driver не найден/u,
    );
  });

  test('ответ драйвера разбирается, код 0', async () => {
    const root = fakeProject({ responses: [{ out: nextResponse(), code: 0 }] });
    const result = await callDriver({ root, args: ['next'] });

    assert.equal(result.code, 0);
    assert.equal(parseStepPlan(result.json).action, 'run');
  });

  test('ненулевой код драйвера возвращается вместе с JSON и stderr', async () => {
    const root = fakeProject({
      responses: [
        {
          out: nextResponse({ action: 'blocked', reason: 'gate_failed' }),
          code: 1,
          err: 'blocked\n',
        },
      ],
    });
    const result = await callDriver({ root, args: ['next'] });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'blocked');
    assert.equal(parseStepPlan(result.json).action, 'blocked');
  });

  test('не JSON на выходе — json null, а не исключение', async () => {
    const root = fakeProject({ responses: [{ out: 'это не JSON', code: 2 }] });
    const result = await callDriver({ root, args: ['next'] });

    assert.equal(result.code, 2);
    assert.equal(result.json, null);
  });
});
