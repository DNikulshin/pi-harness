/**
 * Тесты прогона (`src/run.mjs`): остановки, подтверждения, отказы и лимит шагов.
 *
 * Прогон проверяется на подставленных зависимостях: `next`/`runOne` отдают заранее заготовленные
 * ответы, поэтому не нужны ни ядро, ни реальный цикл. Главное свойство — адаптер не «доигрывает»
 * работу, которую должен делать человек.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseRunOutcome, runCycle } from '../src/run.mjs';

/**
 * Заготовка прогона: очередь планов и ответов `run`.
 * @param {Array<Record<string, unknown> | null>} plans ответы `next` по порядку (`null` — битый JSON)
 * @param {Array<{json: unknown, code?: number}>} runs ответы `run` по порядку
 */
function harness(plans, runs = []) {
  /** @type {Array<{text: string, level: string}>} */
  const notices = [];
  /** @type {string[]} */
  const confirmed = [];
  let confirmAnswer = true;
  let nextCalls = 0;
  let runCalls = 0;

  const deps = {
    next: async () => {
      const index = Math.min(nextCalls, plans.length - 1);
      const json = plans[index] ?? null;
      nextCalls += 1;
      return { json, code: json?.action === 'blocked' ? 1 : 0 };
    },
    runOne: async () => {
      const entry = runs[Math.min(runCalls, runs.length - 1)] ?? { json: null, code: 2 };
      runCalls += 1;
      return { json: entry.json, code: entry.code ?? 0 };
    },
    /** @param {string} text */
    confirm: async (text) => {
      confirmed.push(text);
      return confirmAnswer;
    },
    /** @param {string} text @param {string} level */
    notify: (text, level) => notices.push({ text, level }),
  };

  return {
    deps,
    notices,
    confirmed,
    get nextCalls() {
      return nextCalls;
    },
    get runCalls() {
      return runCalls;
    },
    /** @param {boolean} value */
    answer(value) {
      confirmAnswer = value;
    },
  };
}

/** План шага по контракту. */
const RUN = {
  contract: 'cycle-driver.next/1',
  stage: 'PLAN',
  status: 'running',
  action: 'run',
  step: 'plan',
  reason: 'plan_missing',
  target: null,
  waiting_for: null,
  commands: ['node scripts/cycle-state.mjs finish --stage PLAN --status done'],
  cycle: { iteration: 1, max_iterations: 3, branch: 'feat/1-x', escalation: null },
  done: { stages: [] },
};

/** Успешный ответ `run` с одной исполненной командой. */
const RUN_OK = {
  json: { driver: 'run', dir: '.pi/artifacts/x', executed: [{ command: 'node …', code: 0 }] },
  code: 0,
};

describe('runCycle: остановки без исполнения', () => {
  for (const action of ['spawn', 'handoff', 'stop', 'blocked']) {
    test(`${action} — останавливаемся, run не вызывается`, async () => {
      const h = harness([{ ...RUN, action }]);
      const report = await runCycle(h.deps);

      assert.equal(report.stopped, action);
      assert.equal(report.steps, 0);
      assert.equal(h.runCalls, 0, 'run не должен вызываться на остановке');
      assert.equal(h.notices.length, 1);
      assert.equal(h.notices[0]?.level, action === 'blocked' ? 'error' : 'info');
    });
  }
});

describe('runCycle: подтверждение перехода', () => {
  /** Остановка на PR после входа в стадию. */
  const toPr = { ...RUN, action: 'handoff', stage: 'PR', reason: 'pr_ready' };

  test('вход в PR спрашивает владельца и после согласия исполняет шаг', async () => {
    const h = harness(
      [{ ...RUN, action: 'advance', target: 'PR', reason: 'ready_for_pr' }, toPr],
      [RUN_OK],
    );
    const report = await runCycle(h.deps);

    assert.equal(h.confirmed.length, 1);
    assert.match(h.confirmed[0] ?? '', /Переход PLAN → PR/u);
    assert.equal(report.steps, 1);
    assert.equal(report.stopped, 'handoff');
  });

  test('отказ владельца не исполняет шаг и не двигает стадию', async () => {
    const h = harness([{ ...RUN, action: 'advance', target: 'PR' }], [RUN_OK]);
    h.answer(false);
    const report = await runCycle(h.deps);

    assert.equal(report.stopped, 'declined');
    assert.equal(report.steps, 0);
    assert.equal(h.runCalls, 0, 'после отказа run вызываться не должен');
    assert.match(h.notices.at(-1)?.text ?? '', /ничего не исполнено/u);
  });

  test('вход в ESCALATED тоже спрашивает', async () => {
    const h = harness(
      [
        { ...RUN, action: 'advance', target: 'ESCALATED' },
        { ...RUN, action: 'stop' },
      ],
      [RUN_OK],
    );
    await runCycle(h.deps);

    assert.equal(h.confirmed.length, 1);
    assert.match(h.confirmed[0] ?? '', /→ ESCALATED/u);
  });
});

describe('runCycle: отказы драйвера', () => {
  test('упавшая команда — остановка с названием команды и кодом', async () => {
    const h = harness(
      [RUN, { ...RUN, action: 'stop' }],
      [
        {
          json: { driver: 'run', executed: [{ command: 'node scripts/cycle-gates.mjs', code: 2 }] },
          code: 2,
        },
      ],
    );
    const report = await runCycle(h.deps);

    assert.equal(report.stopped, 'failed');
    assert.equal(report.steps, 0);
    const message = h.notices.at(-1)?.text ?? '';
    assert.match(message, /node scripts\/cycle-gates\.mjs/u);
    assert.match(message, /код 2/u);
  });

  test('ничего не исполнено и нет упавшей команды — отказ с кодом', async () => {
    const h = harness(
      [RUN],
      [{ json: { driver: 'run', executed: [], error: 'нет активного цикла' }, code: 2 }],
    );
    const report = await runCycle(h.deps);

    assert.equal(report.stopped, 'failed');
    assert.match(h.notices.at(-1)?.text ?? '', /нет активного цикла/u);
  });

  test('чужой контракт в next — отказ, а не работа наугад', async () => {
    const h = harness([{ ...RUN, contract: 'cycle-driver.next/2' }]);
    const report = await runCycle(h.deps);

    assert.equal(report.stopped, 'failed');
    assert.equal(h.runCalls, 0);
    assert.match(h.notices.at(-1)?.text ?? '', /cycle-driver\.next\/1/u);
  });

  test('битый JSON в next — отказ с текстом', async () => {
    const h = harness([null]);
    const report = await runCycle(h.deps);

    assert.equal(report.stopped, 'failed');
    assert.match(h.notices.at(-1)?.text ?? '', /не JSON/u);
  });
});

describe('runCycle: лимит шагов за вызов', () => {
  test('предел шагов останавливает прогон и просит повторить', async () => {
    const h = harness([RUN], [RUN_OK]);
    const report = await runCycle({ ...h.deps, maxSteps: 3 });

    assert.equal(report.steps, 3);
    assert.equal(report.stopped, 'limit');
    assert.match(h.notices.at(-1)?.text ?? '', /предел за один вызов/u);
  });
});

describe('parseRunOutcome: разбор ответа run', () => {
  test('лимит шагов после исполненной команды — не отказ, а признак «шаг сделан»', () => {
    const outcome = parseRunOutcome(
      {
        driver: 'run',
        dir: '.pi/artifacts/x',
        executed: [{ command: 'node …', code: 0 }],
        error: 'лимит шагов (1) исчерпан',
      },
      1,
    );

    assert.equal(outcome.executed, 1);
    assert.equal(outcome.failed, null);
    assert.equal(outcome.error, 'лимит шагов (1) исчерпан');
  });

  test('остановка драйвера приходит планом шага', () => {
    const outcome = parseRunOutcome(
      { driver: 'run', executed: [], next: { ...RUN, action: 'handoff', stage: 'CODE' } },
      0,
    );

    assert.equal(outcome.stop?.action, 'handoff');
    assert.equal(outcome.failed, null);
  });

  test('не JSON — ошибка', () => {
    assert.equal(parseRunOutcome(null, 2).error, 'драйвер вернул не JSON о исполнении шага');
  });
});
