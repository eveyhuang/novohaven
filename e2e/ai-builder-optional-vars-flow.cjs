#!/usr/bin/env node
/* eslint-disable no-console */
const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:3000';
const TARGET_ERROR = '缺少必需测试输入: purpose, tone, context';

const userPrompt = `我要创建一个翻译的技能。 我的美国客户会给我发消息, 我需要一个技能帮我把我的中文回复翻译成合适的英文。 保持简洁，口语化的，非常友善的语言。并且使用的时候我可以提供我想达成的目的或者采用的语气 (但也可以不提供), 也可以提供用户发给我的消息（不是必须的)作为翻译的上下文context`;

const mockedAssistantText = `好的！我为你做了一个可复用的“中文回复 → 美式友善英文”翻译技能。它默认简洁、口语化且非常友善；你也可以在使用时“可选地”提供你想达成的目的（purpose）或偏好的语气（tone），以及客户原话（context）来帮助更贴合场景。输出只给最终英文，不带多余说明。

下面是完整的工作流配置，你可以直接保存并运行。`;

const mockedWorkflow = {
  name: '友善口语商务翻译',
  description: '将中文回复翻译为简洁、友善、口语化的英文',
  requiredInputs: [
    { name: 'cn_reply', type: 'textarea', description: '你的中文回复（必填）' },
  ],
  steps: [
    {
      step_name: '运行友善口语商务翻译',
      step_type: 'ai',
      ai_model: 'gpt-5.2',
      prompt_template: [
        'You are a friendly U.S. business communication translator.',
        'Translate the Chinese reply into concise, warm, spoken English.',
        'Chinese reply: {{cn_reply}}',
        'Optional purpose: {{purpose}}',
        'Optional tone: {{tone}}',
        'Optional context: {{context}}',
        'Output ONLY the final English message.',
      ].join('\n'),
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
    await page.waitForTimeout(300);
  }
}

async function fillInputIfPresent(page, name, value) {
  const label = page.locator('label', { hasText: new RegExp(`^${name}$`, 'i') }).first();
  if (!(await label.count())) return false;
  const inputId = await label.getAttribute('for');
  if (!inputId) return false;
  const safeId = inputId.replace(/"/g, '\\"');
  const textArea = page.locator(`[id="${safeId}"]`).first();
  if (!(await textArea.count())) return false;
  await textArea.fill(value);
  return true;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let assistantCalls = 0;
  await page.route('**/api/assistant/generate', async (route) => {
    assistantCalls += 1;
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

  try {
    await page.goto(`${BASE_URL}/workflows/ai-builder`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await ensureChinese(page);

    const chatInput = page.locator('textarea[placeholder*="描述"], textarea[placeholder*="workflow"]').first();
    await chatInput.fill(userPrompt);
    await clickSend(page);

    await page.waitForFunction(() => {
      return !!Array.from(document.querySelectorAll('*')).find((el) =>
        (el.textContent || '').includes('可复用') || (el.textContent || '').includes('workflow configuration')
      );
    }, { timeout: 15000 });

    assert(assistantCalls > 0, 'Assistant generate API was not called');

    let cnFilled = await fillInputIfPresent(page, 'cn_reply', '不行，不能更便宜了。已经是最低的价格。');
    if (!cnFilled) {
      const section = page.locator('div.border-t').last();
      const textareas = section.locator('textarea');
      if (await textareas.count()) {
        await textareas.first().fill('不行，不能更便宜了。已经是最低的价格。');
        cnFilled = true;
      }
    }
    assert(cnFilled, 'Could not find cn_reply test input');

    // If optional fields are rendered by current client logic, leave them blank intentionally.
    await fillInputIfPresent(page, 'purpose', '');
    await fillInputIfPresent(page, 'tone', '');
    await fillInputIfPresent(page, 'context', '');

    const testBtn = page.getByRole('button', { name: /在聊天中测试|Run Test in Chat/i }).first();
    await testBtn.click();

    // Wait for either an immediate validation error or a started execution signal.
    await page.waitForTimeout(2500);

    const bodyText = (await page.locator('body').innerText()) || '';
    if (bodyText.includes(TARGET_ERROR)) {
      throw new Error(`Observed regression: "${TARGET_ERROR}"`);
    }

    const hasStarted = /测试执行已开始|Test execution started/i.test(bodyText);
    console.log(`[PASS] Flow executed. assistantCalls=${assistantCalls}, started=${hasStarted}`);
  } catch (err) {
    try {
      await page.screenshot({ path: 'e2e/artifacts/ai-builder-optional-vars-flow-fail.png', fullPage: true });
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
