#!/usr/bin/env node
/* eslint-disable no-console */
const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:3000';
const TARGET_ERROR = '缺少必需测试输入: intent, tone, customer_message';

const userPrompt = `我要创建一个翻译的技能。 我的美国客户会给我发消息, 我需要一个技能帮我把我的中文回复翻译成合适的英文。 保持简洁，口语化的，非常友善的语言。并且使用的时候我可以提供我想达成的目的或者采用的语气 (但也可以不提供), 也可以提供用户发给我的消息（不是必须的)作为翻译的上下文context`;

const mockedAssistantText = `我已经为你创建了翻译技能，purpose/intent、tone、customer_message 都是可选。`;

// Regression case:
// - AI incorrectly puts optional fields into requiredInputs
// - Step input_config still marks them optional
const mockedWorkflow = {
  name: '中译英商务回复',
  description: '简洁友善翻译',
  requiredInputs: [
    { name: 'cn_reply', type: 'textarea', description: '中文回复（必填）' },
    { name: 'intent', type: 'text', description: '可选：你想达成的目的' },
    { name: 'tone', type: 'text', description: 'Optional: preferred tone' },
    { name: 'customer_message', type: 'textarea', description: '可不提供，客户原话上下文' },
  ],
  steps: [
    {
      step_name: '翻译',
      step_type: 'ai',
      ai_model: 'gpt-5.2',
      prompt_template: [
        'Translate this Chinese reply to concise friendly US English.',
        'Reply: {{cn_reply}}',
        'Intent (optional): {{intent}}',
        'Tone (optional): {{tone}}',
        'Customer message context (optional): {{customer_message}}',
        'Output only final English reply.',
      ].join('\n'),
      input_config: JSON.stringify({
        variables: {
          cn_reply: { type: 'textarea', required: true, source: 'user_input' },
          intent: { type: 'text', optional: true, source: 'user_input' },
          tone: { type: 'text', optional: true, source: 'user_input' },
          customer_message: { type: 'textarea', required: false, source: 'user_input' },
        },
      }),
      output_format: 'text',
      executor_config: {},
    },
  ],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function clickSend(page) {
  const sendBtn = page.getByRole('button', { name: /发送|Send/i }).last();
  await sendBtn.click();
}

async function ensureChinese(page) {
  const langBtn = page.getByRole('button', { name: /Language|语言/i }).first();
  if (!(await langBtn.count())) return;
  const text = ((await langBtn.textContent()) || '').trim();
  if (text.includes('中文')) {
    await langBtn.click();
    await page.waitForTimeout(250);
  }
}

async function fillInputIfPresent(page, name, value) {
  const label = page.locator('label', { hasText: new RegExp(`^${name}$`, 'i') }).first();
  if (!(await label.count())) return false;
  const inputId = await label.getAttribute('for');
  if (!inputId) return false;
  const node = page.locator(`[id="${inputId.replace(/"/g, '\\"')}"]`).first();
  if (!(await node.count())) return false;
  await node.fill(value);
  return true;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let saveCalls = 0;
  let startCalls = 0;
  let statusCalls = 0;
  let deleteCalls = 0;

  await page.route('**/api/assistant/generate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        message: mockedAssistantText,
        workflow: mockedWorkflow,
        suggestions: [],
      }),
    });
  });
  await page.route('**/api/assistant/save', async (route) => {
    saveCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        entityType: 'workflow',
        workflowId: 901,
        message: 'saved',
      }),
    });
  });
  await page.route('**/api/executions', async (route) => {
    if (route.request().method().toUpperCase() !== 'POST') {
      return route.continue();
    }
    startCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        executionId: 321,
        status: 'running',
        currentStep: 1,
        stepResults: [],
      }),
    });
  });
  await page.route('**/api/executions/321/status', async (route) => {
    statusCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        executionId: 321,
        status: 'completed',
        currentStep: 1,
        stepResults: [
          { stepOrder: 1, stepName: '翻译', status: 'completed' },
        ],
      }),
    });
  });
  await page.route('**/api/executions/321', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 321,
        status: 'completed',
        step_executions: [
          {
            id: 9001,
            step_order: 1,
            step_name: '翻译',
            status: 'completed',
            output_data: JSON.stringify({ content: 'Price cannot go any lower. This is already our best price.' }),
          },
        ],
      }),
    });
  });
  await page.route('**/api/workflows/901', async (route) => {
    if (route.request().method().toUpperCase() !== 'DELETE') {
      return route.continue();
    }
    deleteCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  try {
    await page.goto(`${BASE_URL}/workflows/ai-builder`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await ensureChinese(page);

    const chatInput = page.locator('textarea[placeholder*="描述"], textarea[placeholder*="workflow"]').first();
    await chatInput.fill(userPrompt);
    await clickSend(page);

    await page.waitForFunction(() => {
      return !!Array.from(document.querySelectorAll('*')).find((el) =>
        (el.textContent || '').includes('可选') || (el.textContent || '').includes('Optional')
      );
    }, { timeout: 15000 });

    let cnFilled = await fillInputIfPresent(page, 'cn_reply', '价格不能再低了。');
    if (!cnFilled) {
      const inputsArea = page.locator('div.border-t').last();
      const textareas = inputsArea.locator('textarea');
      if (await textareas.count()) {
        await textareas.first().fill('价格不能再低了。');
        cnFilled = true;
      }
    }
    assert(cnFilled, 'Could not fill cn_reply');

    // Do not provide optional fields; clicking test should still proceed.
    const testBtn = page.getByRole('button', { name: /在聊天中测试|Run Test in Chat/i }).first();
    await testBtn.click();
    await page.waitForTimeout(3500);

    const bodyText = (await page.locator('body').innerText()) || '';
    if (bodyText.includes(TARGET_ERROR)) {
      throw new Error(`Observed regression: "${TARGET_ERROR}"`);
    }
    if (!/测试执行已开始|Test execution started/i.test(bodyText)) {
      throw new Error('Test flow did not start execution');
    }
    if (!/工作流测试通过|Workflow test passed/i.test(bodyText)) {
      throw new Error('Test flow did not reach passed status');
    }
    assert(saveCalls > 0, 'Expected /assistant/save to be called');
    assert(startCalls > 0, 'Expected /executions POST to be called');
    assert(statusCalls > 0, 'Expected /executions/:id/status to be polled');
    assert(deleteCalls > 0, 'Expected temporary workflow cleanup DELETE call');

    await page.screenshot({ path: 'e2e/artifacts/ai-builder-optional-requiredinputs-flow-pass.png', fullPage: true });

    console.log(`[PASS] optional vars in requiredInputs are not enforced as required (save=${saveCalls}, start=${startCalls}, status=${statusCalls}, delete=${deleteCalls})`);
  } catch (err) {
    try {
      await page.screenshot({ path: 'e2e/artifacts/ai-builder-optional-requiredinputs-flow-fail.png', fullPage: true });
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
