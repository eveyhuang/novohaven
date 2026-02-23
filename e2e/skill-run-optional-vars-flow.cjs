#!/usr/bin/env node
/* eslint-disable no-console */
const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:3000';
const SKILL_ID = 999;
const TARGET_ERROR = '请填写所有必填字段: goal_or_tone, client_message';

const mockSkill = {
  id: SKILL_ID,
  name: '中转英 翻译给客户的回复',
  description: '将中文回复翻译成友善美式英文',
  status: 'active',
  steps: [
    {
      id: 1,
      step_order: 1,
      step_name: '中转英 翻译给客户的回复',
      step_type: 'ai',
      ai_model: 'gpt-5.2',
      prompt_template: [
        'You are a US-business-friendly translator.',
        'Inputs:',
        '- Chinese reply: {{chinese_reply}}',
        '- Goal/Tone (optional): {{goal_or_tone}}',
        '- Customer message context (optional): {{client_message}}',
        '- Company voice (optional): {{company_voice}}',
        'Output the final English message only.',
      ].join('\n'),
      output_format: 'text',
      model_config: JSON.stringify({ maxTokens: 1200 }),
      input_config: JSON.stringify({
        variables: {
          chinese_reply: {
            type: 'textarea',
            required: true,
            label: 'chinese_reply',
            description: '你要发给客户的中文回复。',
          },
        },
      }),
      executor_config: '{}',
    },
  ],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let executionPostCount = 0;
  let executionPayload = null;

  await page.route('**/api/ai/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: [{ id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai', available: true }],
        all: [{ id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai', available: true }],
      }),
    });
  });

  await page.route('**/api/executors', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          type: 'ai',
          displayName: 'AI',
          icon: '🧠',
          description: 'AI step',
          configSchema: { fields: [] },
        },
      ]),
    });
  });

  await page.route(`**/api/skills/${SKILL_ID}`, async (route) => {
    if (route.request().method().toUpperCase() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockSkill),
      });
      return;
    }
    await route.continue();
  });

  await page.route('**/api/executions', async (route) => {
    if (route.request().method().toUpperCase() !== 'POST') {
      return route.continue();
    }
    executionPostCount += 1;
    executionPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        executionId: 4567,
        status: 'running',
        currentStep: 1,
        stepResults: [],
      }),
    });
  });

  try {
    await page.goto(`${BASE_URL}/skills/${SKILL_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');

    const runButton = page.getByRole('button', { name: /运行|Run/i }).first();
    await runButton.click();

    // Fill only required input.
    const chineseInput = page.locator('#chinese_reply').first();
    if (!(await chineseInput.count())) {
      throw new Error('Could not find chinese_reply input');
    }
    await chineseInput.fill('你别想再占我的便宜了');

    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('*')).some((el) =>
        (el.textContent || '').includes('输入值') || (el.textContent || '').includes('Input Values')
      );
    }, { timeout: 15000 });

    const modalRunButton = page.getByRole('button', { name: /运行|Run/i }).last();
    await modalRunButton.click();
    await page.waitForTimeout(1200);

    const bodyText = (await page.locator('body').innerText()) || '';
    if (bodyText.includes(TARGET_ERROR)) {
      throw new Error(`Observed regression: "${TARGET_ERROR}"`);
    }

    assert(executionPostCount > 0, 'Expected POST /api/executions to run');
    assert(executionPayload && executionPayload.input_data, 'Expected execution payload with input_data');
    const inputData = executionPayload.input_data || {};
    assert(typeof inputData.chinese_reply === 'string' && inputData.chinese_reply.length > 0, 'Expected chinese_reply in payload');
    assert(!('goal_or_tone' in inputData), 'Optional goal_or_tone should be omitted when blank');
    assert(!('client_message' in inputData), 'Optional client_message should be omitted when blank');

    await page.screenshot({ path: 'e2e/artifacts/skill-run-optional-vars-flow-pass.png', fullPage: true });
    console.log('[PASS] Skill run allows optional prompt vars to stay blank');
  } catch (err) {
    try {
      await page.screenshot({ path: 'e2e/artifacts/skill-run-optional-vars-flow-fail.png', fullPage: true });
    } catch {}
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[FAIL] ${err.message || err}`);
  process.exit(1);
});
