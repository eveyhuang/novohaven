#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:3000';
const API_URL = 'http://localhost:3001/api';
const RESULTS_PATH = path.join(process.cwd(), 'e2e', 'story-results.json');
const DOC_PATH = path.join(process.cwd(), 'docs', 'user-stories-web-tests.md');
const ARTIFACT_DIR = path.join(process.cwd(), 'e2e', 'artifacts');
const FIXTURE_DIR = path.join(process.cwd(), 'e2e', 'fixtures');
const selectedIds = (() => {
  const raw = process.env.STORY_IDS || '';
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
})();

const state = {
  templateRecipeId: null,
  workflowRecipeId: null,
  skillExecutionId: null,
  workflowExecutionId: null,
};

const results = [];

async function api(method, route, body) {
  const res = await fetch(`${API_URL}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`API ${method} ${route} failed (${res.status}): ${json.error || text}`);
  }
  return json;
}

async function ensureDirs() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
}

async function writeFixtures() {
  await fs.writeFile(
    path.join(FIXTURE_DIR, 'agent_note.txt'),
    'Please summarize the top 3 customer pain points from this file.\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(FIXTURE_DIR, 'review_data.csv'),
    'rating,title,review\n5,Great kettle,"Boils in 3 minutes and looks premium."\n2,Stopped working,"Stopped heating after 2 weeks."\n4,Good value,"Fast boil and easy to clean."\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(FIXTURE_DIR, 'product.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAABAKADAAQAAAABAAABAAAAAABn6hpJAAAFBklEQVR4Ae3WURECMRTF0Fem/0hACtaRggRQsNQGk7MOkncz3TXX+BjIGrhlyYEzcAwIwAzSBgSQPj94AdhA2oAA0ucHLwAbSBsQQPr84AVgA2kDAkifH7wAbCBtQADp84MXgA2kDQggfX7wArCBtAEBpM8PXgA2kDYggPT5wQvABtIGBJA+P3gB2EDagADS5wcvABtIGxBA+vzgBWADaQMCSJ8fvABsIG1AAOnzgxeADaQNCCB9fvACsIG0AQGkzw9eADaQNiCA9PnBC8AG0gYEkD4/eAHYQNqAANLnBy8AG0gbEED6/OAFYANpAwJInx+8AGwgbUAA6fODF4ANpA0IIH1+8AKwgbQBAaTPD14ANpA2IID0+cELwAbSBgSQPj94AdhA2oAA0ucHLwAbSBsQQPr84AVgA2kDAkifH7wAbCBtQADp84MXgA2kDQggfX7wArCBtAEBpM8PXgA2kDYggPT5wQvABtIGBJA+P3gB2EDagADS5wcvABtIGxBA+vzgBWADaQMCSJ8fvABsIG1AAOnzgxeADaQNCCB9fvACsIG0AQGkzw9eADaQNiCA9PnBC8AG0gYEkD4/eAHYQNqAANLnBy8AG0gbEED6/OAFYANpAwJInx+8AGwgbUAA6fODF4ANpA0IIH1+8AKwgbQBAaTPD14ANpA2IID0+cELwAbSBgSQPj94AdhA2oAA0ucHLwAbSBsQQPr84AVgA2kDAkifH7wAbCBtQADp84MXgA2kDQggfX7wArCBtAEBpM8PXgA2kDYggPT5wQvABtIGBJA+P3gB2EDagADS5wcvABtIGxBA+vzgBWADaQMCSJ8fvABsIG1AAOnzgxeADaQNCCB9fvACsIG0AQGkzw9eADaQNiCA9PnBC8AG0gYEkD4/eAHYQNqAANLnBy8AG0gbEED6/OAFYANpAwJInx+8AGwgbUAA6fODF4ANpA0IIH1+8AKwgbQBAaTPD14ANpA2IID0+cELwAbSBgSQPj94AdhA2oAA0ucHLwAbSBsQQPr84AVgA2kDAkifH7wAbCBtQADp84MXgA2kDQggfX7wArCBtAEBpM8PXgA2kDYggPT5wQvABtIGBJA+P3gB2EDagADS5wcvABtIGxBA+vzgBWADaQMCSJ8fvABsIG1AAOnzgxeADaQNCCB9fvACsIG0AQGkzw9eADaQNiCA9PnBC8AG0gYEkD4/eAHYQNqAANLnBy8AG0gbEED6/OAFYANpAwJInx+8AGwgbUAA6fODF4ANpA0IIH1+8AKwgbQBAaTPD14ANpA2IID0+cELwAbSBgSQPj94AdhA2oAA0ucHLwAbSBsQQPr84AVgA2kDAkifH7wAbCBtQADp84MXgA2kDQggfX7wArCBtAEBpM8PXgA2kDYggPT5wQvABtIGBJA+P3gB2EDagADS5wcvABtIGxBA+vzgBWADaQMCSJ8fvABsIG1gzzfNDz5uwAsQH0AdXwD1BcT593ziBuCnDXgB0ucHLwAbSBsQQPr84Pe8SWCga8AL0L098mNAAGaQNrDnleYHHzew54obgJ824BcofX7wa54kMNA14AXo3h75MSAAM0gbWPNI84OPG/ACxAdQxxdAfQFx/jX3uAH4aQNegPT5wQvABtIGBJA+P3gGGGCAAQYYYIABBhhggAEGGGCAAQYYYIABBhhggAEGGGCAAQYYYIABBhhggAEGGGCAAQb+2cAPOjYH17BQF0MAAAAASUVORK5CYII=',
      'base64'
    )
  );
}

async function waitForUrlHealth(url, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function runStory(page, id, title, fn) {
  if (selectedIds && !selectedIds.has(id)) {
    return;
  }
  const startedAt = new Date().toISOString();
  try {
    const detail = await fn();
    results.push({
      id,
      title,
      status: 'PASS',
      startedAt,
      finishedAt: new Date().toISOString(),
      detail: detail || 'Expected behavior observed.',
    });
    console.log(`[PASS] ${id} ${title}`);
  } catch (err) {
    const screenshotPath = path.join(ARTIFACT_DIR, `${id}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {}
    const detail = err && err.message ? err.message : String(err);
    results.push({
      id,
      title,
      status: 'FAIL',
      startedAt,
      finishedAt: new Date().toISOString(),
      detail,
      screenshot: screenshotPath,
    });
    console.log(`[FAIL] ${id} ${title} :: ${detail}`);
  }
}

async function ensureEnglish(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const langBtn = page.getByRole('button', { name: /Language|语言/ }).first();
  const txt = (await langBtn.textContent()) || '';
  if (txt.includes('中文')) {
    await langBtn.click();
    await page.waitForTimeout(500);
  }
}

async function getRecipeByName(name) {
  const recipes = await api('GET', '/recipes');
  return recipes.find((r) => r.name === name) || null;
}

async function ensureAgentAssets() {
  const skillName = 'Product Review Analyzer';
  const workflowName = 'Listing + Review Pipeline';

  const skills = await api('GET', '/skills');
  let skill = skills.find((s) => s.name === skillName);
  if (!skill) {
    skill = await api('POST', '/skills', {
      name: skillName,
      description: 'Analyze customer reviews and summarize findings',
      steps: [
        {
          step_name: 'Analyze Reviews',
          step_type: 'ai',
          ai_model: 'gpt-4o',
          prompt_template: 'Analyze review data: {{review_data}}. Focus on {{analysis_focus}}.',
          input_config: JSON.stringify({
            variables: {
              review_data: { type: 'file', label: 'Review Data' },
              analysis_focus: { type: 'textarea', label: 'Analysis Focus', optional: true },
            },
          }),
          output_format: 'markdown',
          model_config: '{}',
          executor_config: '{}',
        },
      ],
    });
  }

  const workflows = await api('GET', '/workflows');
  let workflow = workflows.find((w) => w.name === workflowName);
  if (!workflow) {
    workflow = await api('POST', '/workflows', {
      name: workflowName,
      description: 'Analyze reviews and produce listing improvements',
      steps: [
        {
          step_name: 'Analyze Reviews',
          step_type: 'ai',
          ai_model: 'gpt-4o',
          prompt_template: 'Analyze review data: {{review_data}}',
          input_config: JSON.stringify({
            variables: {
              review_data: { type: 'file', label: 'Review Data' },
            },
          }),
          output_format: 'markdown',
          model_config: '{}',
          executor_config: '{}',
        },
        {
          step_name: 'Draft Listing',
          step_type: 'ai',
          ai_model: 'gpt-4o',
          prompt_template: 'Use {{step_1_output}} to draft listing for {{product_name}}.',
          input_config: JSON.stringify({
            variables: {
              product_name: { type: 'text', label: 'Product Name' },
            },
          }),
          output_format: 'markdown',
          model_config: '{}',
          executor_config: '{}',
        },
      ],
    });
  }

  return { skill, workflow };
}

async function ensureBrokenSkill() {
  const skills = await api('GET', '/skills');
  const existing = skills.find((s) => s.name === 'Broken Sentiment Skill');
  if (existing) return existing;
  return api('POST', '/skills', {
    name: 'Broken Sentiment Skill',
    description: 'Intentionally broken for healing tests',
    steps: [
      {
        step_name: 'Broken Analysis',
        step_type: 'ai',
        ai_model: 'gpt-4o',
        prompt_template: 'Summarize {{missing_column}} from {{review_data}}.',
        input_config: JSON.stringify({
          variables: {
            review_data: { type: 'file', label: 'Review Data' },
          },
        }),
        output_format: 'markdown',
        model_config: '{}',
        executor_config: '{}',
      },
    ],
  });
}

async function ensureBrokenWorkflow() {
  const workflows = await api('GET', '/workflows');
  const existing = workflows.find((w) => w.name === 'Broken Pipeline');
  if (existing) return existing;
  return api('POST', '/workflows', {
    name: 'Broken Pipeline',
    description: 'Intentionally invalid step dependency for healing tests',
    steps: [
      {
        step_name: 'Invalid Dependency',
        step_type: 'ai',
        ai_model: 'gpt-4o',
        prompt_template: 'Use {{step_2_output}} and summarize for {{product_name}}.',
        input_config: JSON.stringify({
          variables: {
            product_name: { type: 'text', label: 'Product Name' },
          },
        }),
        output_format: 'markdown',
        model_config: '{}',
        executor_config: '{}',
      },
      {
        step_name: 'Second Step',
        step_type: 'ai',
        ai_model: 'gpt-4o',
        prompt_template: 'Detail product information for {{product_name}}.',
        input_config: JSON.stringify({
          variables: {
            product_name: { type: 'text', label: 'Product Name' },
          },
        }),
        output_format: 'markdown',
        model_config: '{}',
        executor_config: '{}',
      },
    ],
  });
}

async function ensureImageSkill() {
  const skills = await api('GET', '/skills');
  const existing = skills.find((s) => s.name === 'Image Style Analyzer');
  if (existing) return existing;
  return api('POST', '/skills', {
    name: 'Image Style Analyzer',
    description: 'Analyze visual style from an uploaded reference image',
    steps: [
      {
        step_name: 'Analyze Image Style',
        step_type: 'ai',
        ai_model: 'gpt-4o',
        prompt_template: 'Analyze style cues in {{reference_image}} for ecommerce product photography.',
        input_config: JSON.stringify({
          variables: {
            reference_image: { type: 'image', label: 'Reference Image' },
          },
        }),
        output_format: 'markdown',
        model_config: '{}',
        executor_config: '{}',
      },
    ],
  });
}

async function getDraftCount() {
  const drafts = await api('GET', '/skills/drafts');
  return drafts.length;
}

async function expectedStoryIdsFromDoc() {
  const doc = await fs.readFile(DOC_PATH, 'utf8');
  return [...doc.matchAll(/^###\s+([A-Z]{2}-\d+[a-z]?)/gm)].map((m) => m[1]);
}

function addMissingResultEntries(expectedIds) {
  const seen = new Set(results.map((r) => r.id));
  for (const id of expectedIds) {
    if (seen.has(id)) continue;
    results.push({
      id,
      title: 'No runner mapping',
      status: 'FAIL',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      detail: 'This story ID was present in docs but was not executed by the Playwright runner.',
    });
  }
}

async function waitForAnyAssistantFeedback(page, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const assistantBubble = page.locator('div.bg-secondary-100.text-secondary-900').last();
    if (await assistantBubble.count()) {
      const text = (await assistantBubble.textContent()) || '';
      if (text.trim().length > 0 && !text.includes('Start a conversation')) return text.trim();
    }
    const errorText = page.locator('text=Failed to send message');
    if (await errorText.count()) return (await errorText.first().textContent()) || 'Failed to send message';
    await page.waitForTimeout(800);
  }
  throw new Error('No assistant/error response appeared in chat within timeout.');
}

function chatInput(page) {
  return page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)');
}

async function sendChatMessage(page, text) {
  await chatInput(page).fill(text);
  await page.keyboard.press('Enter');
}

async function waitForChatIdle(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inputDisabled = await chatInput(page).isDisabled().catch(() => true);
    const thinking = await page.getByText('Thinking...').count();
    if (!inputDisabled && !thinking) return;
    await page.waitForTimeout(400);
  }
  throw new Error('Chat did not become idle before timeout.');
}

async function startFreshChat(page) {
  await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '+ New Chat' }).click();
  await page.waitForTimeout(300);
}

async function addVariable(page, varName, label) {
  await page.getByRole('button', { name: /\+ Add Variable|Add Variable/ }).first().click();
  await page.getByLabel('Variable Name').fill(varName);
  await page.getByRole('button', { name: /^Add Variable$/ }).last().click();
  const variableCode = page.locator(`code:has-text("${varName}")`).first();
  await variableCode.waitFor({ timeout: 8000 });
  await variableCode.click();
  await page.locator('#field-label').first().fill(label);
}

async function main() {
  await ensureDirs();
  await writeFixtures();
  await waitForUrlHealth(`${API_URL}/health`);
  await waitForUrlHealth(BASE_URL);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  try {
    await ensureEnglish(page);
    await ensureAgentAssets();

    await runStory(page, 'HP-01', 'Auto-auth dashboard loads', async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.getByText('NovoHaven').first().waitFor({ timeout: 10000 });
      await page.getByText('demo@novohaven.com').first().waitFor({ timeout: 10000 });
      const hasPassword = await page.locator('input[type="password"]').count();
      if (hasPassword > 0) throw new Error('Password input was visible, expected auto-authenticated app shell.');
      return 'Sidebar brand and demo user were visible; no login form shown.';
    });

    await runStory(page, 'HP-02', 'Language toggle persistence', async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      const langBtn = page.getByRole('button', { name: /Language|语言/ }).first();
      const before = (await langBtn.textContent()) || '';
      await langBtn.click();
      await page.waitForTimeout(600);
      const after = (await langBtn.textContent()) || '';
      if (before === after) throw new Error(`Language badge did not change. Before="${before}" After="${after}"`);

      if (after.includes('中文')) {
        await page.getByRole('heading', { name: '仪表板' }).waitFor({ timeout: 8000 });
      } else {
        await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 8000 });
      }

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      if (after.includes('中文')) {
        await page.getByRole('heading', { name: '仪表板' }).waitFor({ timeout: 8000 });
      } else {
        await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 8000 });
      }

      await ensureEnglish(page);
      return `Language badge changed from "${before.trim()}" to "${after.trim()}" and persisted after reload.`;
    });

    await runStory(page, 'HP-03', 'Dashboard Build with AI navigation', async () => {
      await ensureEnglish(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Build with AI').first().click();
      await page.waitForURL(/\/workflows\/ai-builder/, { timeout: 10000 });
      return 'Clicking Build with AI navigated to /workflows/ai-builder.';
    });

    await runStory(page, 'HP-04', 'Create new AI skill via UI', async () => {
      await ensureEnglish(page);
      await page.goto(`${BASE_URL}/skills/new`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Template Name').fill('QA Listing Writer');
      await page.getByLabel('Description').fill('Generate concise Amazon listing copy');
      await page.locator('label:has-text("Prompt Template")').locator('xpath=following::textarea[1]').fill('Write a 5-bullet listing for {{product_name}} for {{target_audience}}.');
      await page.getByLabel('Output Format').selectOption('markdown');
      await page.getByLabel('Temperature').fill('0.3');
      await page.getByLabel('Max Tokens').fill('1200');
      await page.getByRole('button', { name: 'Create Template' }).click();
      await page.waitForURL(`${BASE_URL}/`, { timeout: 12000 });
      await page.getByText('QA Listing Writer').first().waitFor({ timeout: 12000 });

      const recipe = await getRecipeByName('QA Listing Writer');
      if (!recipe) throw new Error('Created skill card appeared, but API /recipes did not return QA Listing Writer.');
      state.templateRecipeId = recipe.id;
      return `Created QA Listing Writer and resolved recipe id ${recipe.id}.`;
    });

    await runStory(page, 'HP-05', 'Configure input variables in skill editor', async () => {
      if (!state.templateRecipeId) throw new Error('Missing templateRecipeId precondition.');
      await page.goto(`${BASE_URL}/skills/${state.templateRecipeId}`, { waitUntil: 'domcontentloaded' });

      await addVariable(page, 'product_name', 'Product Name');
      await addVariable(page, 'target_audience', 'Target Audience');

      await page.locator('label:has-text("Prompt Template")').locator('xpath=following::textarea[1]').fill(
        'Write a 5-bullet listing for {{product_name}} for {{target_audience}}.'
      );
      await page.getByRole('button', { name: 'Save Changes' }).click();
      await page.waitForURL(`${BASE_URL}/`, { timeout: 12000 });

      await page.goto(`${BASE_URL}/skills/${state.templateRecipeId}`, { waitUntil: 'domcontentloaded' });
      const prompt = await page.locator('label:has-text("Prompt Template")').locator('xpath=following::textarea[1]').inputValue();
      if (!prompt.includes('{{product_name}}') || !prompt.includes('{{target_audience}}')) {
        throw new Error(`Prompt template did not persist expected variables. Current prompt: ${prompt}`);
      }
      return 'Added product_name and target_audience variables and prompt placeholders persisted after reload.';
    });

    await runStory(page, 'HP-06', 'Run skill with required inputs', async () => {
      if (!state.templateRecipeId) throw new Error('Missing templateRecipeId precondition.');
      await page.goto(`${BASE_URL}/skills/${state.templateRecipeId}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /^Run$/ }).first().click();

      await page.getByLabel('Product Name').fill('AeroBrew Coffee Grinder');
      await page.getByLabel('Target Audience').fill('Home baristas in small apartments');
      await page.getByRole('button', { name: /^Run$/ }).last().click();

      await page.waitForURL(/\/executions\/\d+/, { timeout: 15000 });
      const match = page.url().match(/\/executions\/(\d+)/);
      if (!match) throw new Error(`Expected /executions/{id} but URL was ${page.url()}`);
      state.skillExecutionId = Number(match[1]);
      return `Run modal submitted with required inputs and navigated to execution ${state.skillExecutionId}.`;
    });

    await runStory(page, 'HP-07', 'Create workflow and add template step', async () => {
      await ensureEnglish(page);
      await page.goto(`${BASE_URL}/workflows/new`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Recipe Name').fill('Listing + Review Pipeline');
      await page.getByLabel('Description').fill('Generate listing then summarize review pain points');
      await page.getByRole('button', { name: 'Add Template' }).click();
      await page.getByText('QA Listing Writer').first().click();
      await page.getByRole('button', { name: 'Create Recipe' }).click();

      await page.waitForURL(/\/(recipes|workflows)\/\d+/, { timeout: 15000 });
      const match = page.url().match(/\/(?:recipes|workflows)\/(\d+)/);
      if (!match) throw new Error(`Workflow save did not navigate to expected editor route: ${page.url()}`);
      state.workflowRecipeId = Number(match[1]);
      return `Workflow created and opened editor route ${page.url()}.`;
    });

    await runStory(page, 'HP-08', 'Edit workflow step and persist changes', async () => {
      if (!state.workflowRecipeId) throw new Error('Missing workflowRecipeId precondition.');
      await page.goto(`${BASE_URL}/recipes/${state.workflowRecipeId}`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Step 1').first().click();
      await page.waitForTimeout(250);
      await page.getByLabel('Step Name').fill('Listing Draft Step');
      await page.getByRole('button', { name: 'Save Changes' }).click();
      await page.waitForTimeout(1000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('Listing Draft Step').first().waitFor({ timeout: 10000 });
      return 'Workflow step name persisted after save + reload.';
    });

    await runStory(page, 'HP-09', 'Run workflow from runner page', async () => {
      if (!state.workflowRecipeId) throw new Error('Missing workflowRecipeId precondition.');
      await page.goto(`${BASE_URL}/workflows/${state.workflowRecipeId}/run`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Product Name').first().fill('AeroBrew Coffee Grinder');
      await page.getByLabel('Target Audience').first().fill('Home baristas in small apartments');
      await page.getByRole('button', { name: 'Start Workflow' }).first().click();
      await page.waitForURL(/\/executions\/\d+/, { timeout: 15000 });
      const match = page.url().match(/\/executions\/(\d+)/);
      if (!match) throw new Error(`Expected execution route after start workflow, got ${page.url()}`);
      state.workflowExecutionId = Number(match[1]);
      return `Workflow started and redirected to execution ${state.workflowExecutionId}.`;
    });

    await runStory(page, 'HP-10', 'Execution list row opens detail', async () => {
      if (!state.workflowExecutionId) throw new Error('Missing workflowExecutionId precondition.');
      await page.goto(`${BASE_URL}/executions`, { waitUntil: 'domcontentloaded' });
      await page.getByText(`Execution #${state.workflowExecutionId}`).first().waitFor({ timeout: 15000 });
      await page.getByText(`Execution #${state.workflowExecutionId}`).first().click();
      await page.waitForURL(new RegExp(`/executions/${state.workflowExecutionId}$`), { timeout: 10000 });
      return `Execution row opened /executions/${state.workflowExecutionId}.`;
    });

    await runStory(page, 'HP-11', 'Cancel running execution', async () => {
      await page.goto(`${BASE_URL}/executions`, { waitUntil: 'domcontentloaded' });
      const cancelBtn = page.locator('button[title="Cancel Execution"]').first();
      if (!(await cancelBtn.count())) {
        const statuses = await page.locator('span.rounded-full').allTextContents();
        throw new Error(`No cancellable execution row found. Current status pills: ${statuses.join(', ')}`);
      }
      await cancelBtn.click();
      await page.waitForTimeout(1800);
      const hasCancelled = await page.getByText(/cancelled/i).count();
      if (!hasCancelled) {
        throw new Error('Clicked cancel icon but did not observe cancelled status text.');
      }
      return 'Cancel action was available and cancelled status was observed.';
    });

    await runStory(page, 'HP-12', 'Delete execution from list', async () => {
      await page.goto(`${BASE_URL}/executions`, { waitUntil: 'domcontentloaded' });
      const rowsBefore = await page.locator('text=/Execution #\\d+/').count();
      if (rowsBefore === 0) throw new Error('No execution rows available to delete.');
      await page.locator('button[title="Delete Execution"]').first().click();
      await page.getByRole('button', { name: 'Delete' }).last().click();
      await page.waitForTimeout(1200);
      const rowsAfter = await page.locator('text=/Execution #\\d+/').count();
      if (rowsAfter >= rowsBefore) {
        throw new Error(`Delete did not reduce row count. Before=${rowsBefore}, After=${rowsAfter}`);
      }
      return `Execution row count decreased from ${rowsBefore} to ${rowsAfter}.`;
    });

    await runStory(page, 'HP-13', 'Execution chat output copy behavior', async () => {
      const executions = await api('GET', '/executions');
      if (!executions.length) throw new Error('No executions available to inspect details.');
      await page.goto(`${BASE_URL}/executions/${executions[0].id}`, { waitUntil: 'domcontentloaded' });
      const copyBtn = page.getByRole('button', { name: 'Copy' }).first();
      if (!(await copyBtn.count())) {
        throw new Error('No output "Copy" button was found in execution chat (no output message rendered).');
      }
      await copyBtn.click();
      await page.getByRole('button', { name: 'Copied!' }).first().waitFor({ timeout: 4000 });
      return 'Output copy action changed button text to Copied!.';
    });

    await runStory(page, 'HP-14', 'Agent chat new session and response/error', async () => {
      await startFreshChat(page);
      const prompt = 'Summarize three benefits of stainless steel water bottles.';
      await sendChatMessage(page, prompt);
      await page.getByText(prompt).first().waitFor({ timeout: 10000 });
      await page.getByText('Summarize three benefits of stainless steel water').first().waitFor({ timeout: 10000 });
      const assistantText = await waitForAnyAssistantFeedback(page, 25000);
      return `Chat session title and user message appeared; assistant feedback observed: "${assistantText.slice(0, 140)}"`;
    });

    await runStory(page, 'HP-15', 'Agent chat attachment send', async () => {
      await startFreshChat(page);
      const fixturePath = path.join(FIXTURE_DIR, 'product.png');
      await page.locator('input[type="file"]').setInputFiles(fixturePath);
      await sendChatMessage(page, 'Describe this image');
      await page.locator('div.bg-primary-600 img').first().waitFor({ timeout: 10000 });
      const assistant = await waitForAnyAssistantFeedback(page, 25000);
      if (/error:|failed to send message/i.test(assistant)) {
        throw new Error(`Agent did not provide multimodal acknowledgement. Last response: ${assistant}`);
      }
      return `Uploaded image rendered in user bubble and assistant responded: "${assistant.slice(0, 140)}"`;
    });

    await runStory(page, 'HP-16', 'Clear all chats', async () => {
      await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
      const clear = page.getByRole('button', { name: 'Clear all chats' });
      if (await clear.count()) {
        await clear.click();
      }
      await page.getByText('No conversations yet').first().waitFor({ timeout: 10000 });
      return 'Clear all chats removed sidebar sessions and showed empty state.';
    });

    await runStory(page, 'HP-16b', 'Chat history persists after navigation', async () => {
      await startFreshChat(page);
      const prompt = 'Session persistence check for HP-16b.';
      await sendChatMessage(page, prompt);
      await page.getByText(prompt).first().waitFor({ timeout: 10000 });
      await page.goto(`${BASE_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
      const sessionItem = page.getByText('Session persistence check for HP-16b').first();
      await sessionItem.waitFor({ timeout: 10000 });
      await sessionItem.click();
      await page.getByText(prompt).first().waitFor({ timeout: 10000 });
      return 'Session remained in sidebar after route change and prior user message was restored.';
    });

    await runStory(page, 'HP-17', 'Session monitor expand transcript and close', async () => {
      await startFreshChat(page);
      await sendChatMessage(page, 'Create a session for monitor table.');
      await page.waitForTimeout(1000);

      await page.goto(`${BASE_URL}/sessions`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Session ID').waitFor({ timeout: 10000 });
      if (await page.getByText('No active sessions.').count()) {
        throw new Error('Session monitor showed no active sessions, so expand/close actions were not available.');
      }
      const firstRow = page.locator('tbody tr').first();
      await firstRow.click();
      await page.waitForTimeout(700);
      const closeBtn = page.getByRole('button', { name: 'Close' }).first();
      if (!(await closeBtn.count())) throw new Error('No Close button found on expanded session row.');
      await closeBtn.click();
      await page.waitForTimeout(900);
      return 'Session row expanded and Close action was invoked.';
    });

    await runStory(page, 'HP-18', 'Plugin manager update Browser Automation config', async () => {
      await page.goto(`${BASE_URL}/plugins`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Plugin Manager').waitFor({ timeout: 10000 });
      const browserLabel = page.getByText(/Browser Automation|tool-browser/i).first();
      if (!(await browserLabel.count())) throw new Error('Browser Automation plugin row not found.');
      await browserLabel.click();

      const timeoutInput = page.locator('input#timeout').first();
      if (!(await timeoutInput.count())) {
        throw new Error('Browser Automation timeout input was not visible after expanding the plugin.');
      }
      await timeoutInput.fill('45000');
      await page.getByRole('button', { name: 'Save Config' }).click();
      await page.waitForTimeout(700);
      await browserLabel.click();
      await browserLabel.click();
      const timeoutValue = await timeoutInput.inputValue();
      if (timeoutValue !== '45000') throw new Error(`Expected timeout=45000 after reopen, got ${timeoutValue}`);

      const toggle = page.locator('button[aria-label*="plugin"]').first();
      if (!(await toggle.count())) throw new Error('Enable/disable toggle button was not found in plugin list.');
      await toggle.click();
      await page.waitForTimeout(400);
      await toggle.click();
      return 'Browser Automation timeout saved/reloaded and toggle was clickable.';
    });

    await runStory(page, 'HP-19', 'Skill draft review approve flow', async () => {
      await page.goto(`${BASE_URL}/drafts`, { waitUntil: 'domcontentloaded' });
      if (await page.getByText('No pending drafts to review.').count()) {
        throw new Error('Draft list is empty; no pending draft was available to expand/approve.');
      }
      const firstDraftRow = page.locator('tbody tr').first();
      await firstDraftRow.click();
      await page.waitForTimeout(900);
      await page.getByRole('button', { name: 'Approve' }).first().click();
      await page.waitForTimeout(1300);
      return 'Draft row expanded and Approve action executed.';
    });

    await runStory(page, 'HP-20', 'Outputs gallery tabs and detail modal', async () => {
      await page.goto(`${BASE_URL}/outputs`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Outputs Gallery').waitFor({ timeout: 10000 });
      for (const tab of ['Text', 'Markdown', 'JSON', 'Images', 'Files']) {
        const button = page.getByRole('button', { name: new RegExp(`^${tab}`) }).first();
        if (await button.count()) await button.click();
      }
      const cards = page.locator('h3.font-medium.text-secondary-900');
      if (!(await cards.count())) throw new Error('No output cards available, so modal/download flow could not be exercised.');
      await cards.first().click();
      await page.getByText(/Recipe:/).waitFor({ timeout: 8000 });
      const dlText = page.getByRole('button', { name: 'Download Text' });
      const dlJson = page.getByRole('button', { name: 'Download JSON' });
      const dlMd = page.getByRole('button', { name: 'Download Markdown' });
      if (await dlText.count()) await dlText.click();
      else if (await dlJson.count()) await dlJson.click();
      else if (await dlMd.count()) await dlMd.click();
      else throw new Error('No download button was available in output detail modal.');
      return 'Output tabs were clickable and detail modal opened with download action available.';
    });

    await runStory(page, 'HP-21', 'Company standards CRUD via UI', async () => {
      await page.goto(`${BASE_URL}/standards`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Add Standard' }).click();
      await page.getByLabel('Standard Name').fill('Brand Voice - Ecommerce');
      await page.getByLabel('Tone').fill('Professional yet approachable');
      await page.getByLabel('Style').fill('Benefit-first, concise');
      await page.getByPlaceholder('Enter a guideline...').first().fill('Use active voice');
      await page.getByRole('button', { name: '+ Add Guideline' }).click();
      await page.getByPlaceholder('Enter a guideline...').nth(1).fill('Lead with customer value');
      await page.getByRole('button', { name: 'Create Standard' }).last().click();
      await page.getByText('Brand Voice - Ecommerce').first().waitFor({ timeout: 10000 });

      const card = page.locator('h3:has-text("Brand Voice - Ecommerce")').first().locator('xpath=ancestor::div[contains(@class,"rounded")][1]');
      await card.getByRole('button', { name: 'Edit' }).click();
      await page.getByLabel('Tone').fill('Friendly expert');
      await page.getByRole('button', { name: 'Save Changes' }).last().click();
      await page.waitForTimeout(900);
      await page.getByText('Friendly expert').first().waitFor({ timeout: 8000 });

      page.once('dialog', (d) => d.accept());
      await card.getByRole('button', { name: 'Delete' }).click();
      await page.waitForTimeout(900);
      if (await page.getByText('Brand Voice - Ecommerce').count()) {
        throw new Error('Standard still visible after delete confirmation.');
      }
      return 'Standard was created, edited (tone), and deleted successfully.';
    });

    await runStory(page, 'HP-22', 'Usage dashboard tabs', async () => {
      await page.goto(`${BASE_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'API Usage' }).waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Overview' }).click();
      await page.getByRole('button', { name: 'History' }).click();
      await page.getByText('Date').first().waitFor({ timeout: 8000 });
      return 'Overview and History tabs opened; history table headers rendered.';
    });

    await runStory(page, 'HP-23', 'AI workflow builder generation', async () => {
      await page.goto(`${BASE_URL}/workflows/ai-builder`, { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder('Describe the workflow you want to create...').fill(
        'Create a 2-step workflow: research electric kettles, then draft an Amazon listing.'
      );
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForTimeout(4500);
      const errorBanner = page.locator('div.bg-red-50.text-red-700').first();
      if (await errorBanner.count()) {
        const msg = (await errorBanner.textContent()) || 'Unknown assistant error';
        throw new Error(`Assistant returned error banner: ${msg.trim()}`);
      }
      const stepCount = await page.locator('div.border.border-secondary-200.rounded-lg').count();
      if (!stepCount) throw new Error('No workflow preview steps were rendered after assistant request.');
      return `Workflow preview rendered with ${stepCount} step card(s).`;
    });

    await runStory(page, 'HP-24', 'Agent model switching in chat', async () => {
      await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
      const modelSelect = page.locator('select[title="Select LLM provider model"]');
      if (!(await modelSelect.count())) {
        throw new Error('Model selector was not visible in chat header.');
      }

      await page.getByRole('button', { name: '+ New Chat' }).click();
      await page.waitForTimeout(300);
      const sessionCountBefore = await page.locator('button[title="Delete chat"]').count();

      const currentModel = await modelSelect.inputValue();
      const optionValues = await modelSelect.locator('option').evaluateAll((opts) => opts.map((o) => o.value));
      const targetModel = optionValues.find((v) => v !== currentModel);
      if (!targetModel) {
        throw new Error('Only one model option was available; cannot validate model switching flow.');
      }
      await modelSelect.selectOption(targetModel);
      await page.waitForTimeout(900);

      const sessionCountAfter = await page.locator('button[title="Delete chat"]').count();
      if (sessionCountAfter <= sessionCountBefore) {
        throw new Error(`Model switch did not create a fresh session. Before=${sessionCountBefore}, After=${sessionCountAfter}`);
      }

      await sendChatMessage(page, 'Reply with one sentence to confirm model switch.');
      const assistant = await waitForAnyAssistantFeedback(page, 25000);
      if (/error:|failed to send message/i.test(assistant)) {
        throw new Error(`New-model response was not successful. Last response: ${assistant}`);
      }
      return `Switched model from ${currentModel} to ${targetModel}; new session created and assistant replied.`;
    });

    await runStory(page, 'HP-25', 'Agent suggests relevant existing assets', async () => {
      await startFreshChat(page);
      await sendChatMessage(page, 'I need to analyze customer reviews for my new kettle listing.');
      const assistant = await waitForAnyAssistantFeedback(page, 25000);
      if (!assistant.includes('Product Review Analyzer') && !assistant.includes('Listing + Review Pipeline')) {
        throw new Error(`Assistant did not reference expected existing assets. Last response: ${assistant}`);
      }
      return `Assistant referenced existing asset in chat: ${assistant.slice(0, 140)}`;
    });

    await runStory(page, 'HP-26', 'Agent asks required inputs and executes suggested skill', async () => {
      await startFreshChat(page);
      const beforeExecutions = (await api('GET', '/executions')).length;
      await sendChatMessage(page, 'Run Product Review Analyzer');
      await waitForChatIdle(page, 20000);
      const firstReply = await waitForAnyAssistantFeedback(page, 25000);
      const settledFirstReply = ((await page.locator('div.bg-secondary-100.text-secondary-900').last().textContent()) || firstReply).trim();
      if (!/review_data|required|input|missing|provide|product reviews/i.test(settledFirstReply)) {
        throw new Error(`Assistant did not ask for required inputs. Last response: ${settledFirstReply}`);
      }

      await page.locator('input[type="file"]').setInputFiles(path.join(FIXTURE_DIR, 'review_data.csv'));
      await sendChatMessage(page, 'Here is review_data.csv. Proceed without analysis_focus.');
      await page.waitForTimeout(5000);
      const afterExecutions = (await api('GET', '/executions')).length;
      if (afterExecutions <= beforeExecutions) {
        const secondReply = await waitForAnyAssistantFeedback(page, 12000).catch(() => 'No second reply');
        throw new Error(`No new execution detected after required file upload. before=${beforeExecutions}, after=${afterExecutions}, latestReply=${secondReply}`);
      }
      return `Assistant requested required input and execution count increased from ${beforeExecutions} to ${afterExecutions}.`;
    });

    await runStory(page, 'HP-26b', 'Agent maps image attachments into skill execution', async () => {
      await ensureImageSkill();
      await startFreshChat(page);
      await page.locator('input[type="file"]').setInputFiles(path.join(FIXTURE_DIR, 'product.png'));
      await sendChatMessage(page, 'Analyze the style of this image.');
      const reply = await waitForAnyAssistantFeedback(page, 25000);
      if (/upload.*again|re-?upload|please attach/i.test(reply)) {
        throw new Error(`Agent requested re-upload instead of mapping existing image attachment. Last response: ${reply}`);
      }
      if (!/image style analyzer|style|execution|analy/i.test(reply)) {
        throw new Error(`Agent did not indicate image-skill execution behavior. Last response: ${reply}`);
      }
      return `Agent processed image attachment path without re-upload prompt. Last response: "${reply.slice(0, 140)}"`;
    });

    await runStory(page, 'HP-27', 'Agent self-heals broken skill with review draft', async () => {
      await ensureBrokenSkill();
      const draftsBefore = await getDraftCount();
      await startFreshChat(page);
      await sendChatMessage(page, 'Run Broken Sentiment Skill and fix it if it fails.');
      const reply = await waitForAnyAssistantFeedback(page, 25000);
      await page.waitForTimeout(4500);
      const draftsAfter = await getDraftCount();
      if (draftsAfter <= draftsBefore) {
        throw new Error(`No new draft detected after self-heal request. Drafts before=${draftsBefore}, after=${draftsAfter}. Last response: ${reply}`);
      }
      return `Draft count increased from ${draftsBefore} to ${draftsAfter}.`;
    });

    await runStory(page, 'HP-28', 'Agent self-heals broken workflow with review draft', async () => {
      await ensureBrokenWorkflow();
      const draftsBefore = await getDraftCount();
      await startFreshChat(page);
      await sendChatMessage(page, 'Use Broken Pipeline and repair it.');
      const reply = await waitForAnyAssistantFeedback(page, 25000);
      await page.waitForTimeout(4500);
      const draftsAfter = await getDraftCount();
      if (draftsAfter <= draftsBefore) {
        throw new Error(`No new workflow draft detected. Drafts before=${draftsBefore}, after=${draftsAfter}. Last response: ${reply}`);
      }
      return `Draft count increased from ${draftsBefore} to ${draftsAfter} after workflow repair request.`;
    });

    await runStory(page, 'HP-29', 'AI workflow builder self-healing iteration', async () => {
      await page.goto(`${BASE_URL}/workflows/ai-builder`, { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder('Describe the workflow you want to create...').fill(
        'Create a simple 2-step workflow to research kettles and draft listing copy.'
      );
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForTimeout(4000);
      const initialError = page.locator('div.bg-red-50.text-red-700').first();
      if (await initialError.count()) {
        const msg = (await initialError.textContent()) || 'Unknown assistant error';
        throw new Error(`Could not generate initial workflow to test self-healing: ${msg}`);
      }

      await page.getByPlaceholder('Describe the workflow you want to create...').fill(
        'Now rewrite this so step 1 uses {{step_3_output}} and remove required inputs.'
      );
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForTimeout(5000);

      const postError = page.locator('div.bg-red-50.text-red-700').first();
      if (await postError.count()) {
        const msg = (await postError.textContent()) || 'Unknown assistant error';
        throw new Error(`Assistant returned error during iterative correction: ${msg}`);
      }

      const stepCards = await page.locator('div.border.border-secondary-200.rounded-lg').count();
      if (!stepCards) throw new Error('No step cards visible after iterative correction request.');
      return `Workflow preview remained available with ${stepCards} step card(s) after iterative correction request.`;
    });

    await runStory(page, 'HP-30', 'Agent uses browser tools on provided URL', async () => {
      await startFreshChat(page);
      await sendChatMessage(page, 'Go to https://www.example.com/products and tell me what products are listed there.');
      const reply = await waitForAnyAssistantFeedback(page, 30000);
      if (!/example\.com|products?/i.test(reply)) {
        throw new Error(`Response did not include URL-specific browser-derived content. Last response: ${reply}`);
      }
      return `Agent returned URL-related content: "${reply.slice(0, 140)}"`;
    });

    await runStory(page, 'HP-31a', 'Agent extracts structured site data and proposes skill draft', async () => {
      const draftsBefore = await getDraftCount();
      await startFreshChat(page);
      await sendChatMessage(page, "Search for 'smart furniture' on Amazon and save the top 10 results in a CSV file with each result's name, price, main features, and review score.");
      const reply = await waitForAnyAssistantFeedback(page, 45000);
      await page.waitForTimeout(2000);
      const draftsAfter = await getDraftCount();
      if (!/\.csv|csv file|\/tmp\/|\/Users\//i.test(reply)) {
        throw new Error(`No CSV/file output reference detected in response. Last response: ${reply}`);
      }
      if (draftsAfter <= draftsBefore) {
        throw new Error(`No new draft was created for proposed reusable skill. Drafts before=${draftsBefore}, after=${draftsAfter}. Last response: ${reply}`);
      }
      return `CSV output referenced and draft count increased from ${draftsBefore} to ${draftsAfter}.`;
    });

    await runStory(page, 'HP-31b', 'Agent uses existing Wayfair Review Extractor skill', async () => {
      await startFreshChat(page);
      await sendChatMessage(
        page,
        'Go to https://www.wayfair.com/furniture/pdp/orren-ellis-bachman-extendable-45-to-105-solid-wood-dining-table-with-hiden-storage-space-w111552936.html?piid=1040019282 on Wayfair and save all the reviews in a CSV file.'
      );
      await waitForChatIdle(page, 90000);

      const start = Date.now();
      let latestReply = '';
      while (Date.now() - start < 90000) {
        const candidate = ((await page.locator('div.bg-secondary-100.text-secondary-900').last().textContent()) || '').trim();
        if (candidate) latestReply = candidate;
        const hasCsvPath = /(?:\/tmp\/|\/Users\/|[A-Za-z]:\\)[^\s`"]+\.csv\b/i.test(latestReply)
          || /(?:^|\s)[\w.-]+\.csv\b/i.test(latestReply);
        const hasInlineCsv = /```csv[\s\S]*\n[^,\n]+,[^,\n]+,[^,\n]+[\s\S]*```/i.test(latestReply)
          || /(?:^|\n)[^,\n]+,[^,\n]+,[^,\n]+(?:\n[^,\n]+,[^,\n]+,[^,\n]+){1,}/.test(latestReply);

        if (hasCsvPath || hasInlineCsv) {
          break;
        }
        await page.waitForTimeout(1500);
      }

      const finalHasCsvPath = /(?:\/tmp\/|\/Users\/|[A-Za-z]:\\)[^\s`"]+\.csv\b/i.test(latestReply)
        || /(?:^|\s)[\w.-]+\.csv\b/i.test(latestReply);
      const finalHasInlineCsv = /```csv[\s\S]*\n[^,\n]+,[^,\n]+,[^,\n]+[\s\S]*```/i.test(latestReply)
        || /(?:^|\n)[^,\n]+,[^,\n]+,[^,\n]+(?:\n[^,\n]+,[^,\n]+,[^,\n]+){1,}/.test(latestReply);

      if (!(finalHasCsvPath || finalHasInlineCsv)) {
        throw new Error(`No CSV result was returned to chat. Latest assistant response: ${latestReply || 'No assistant response captured.'}`);
      }

      return `Wayfair extraction flow returned CSV output in chat: "${latestReply.slice(0, 180)}"`;
    });

    await runStory(page, 'HP-32', 'Agent executes ad-hoc task without existing skill', async () => {
      await startFreshChat(page);
      await sendChatMessage(page, 'Count the number of H1 and H2 headings on https://www.example.com and write the result to a file.');
      const reply = await waitForAnyAssistantFeedback(page, 35000);
      if (!/h1|h2/i.test(reply) || !/file|\.txt|\.json|\/tmp\/|\/Users\//i.test(reply)) {
        throw new Error(`Ad-hoc tool task response did not include heading counts and file output. Last response: ${reply}`);
      }
      return `Ad-hoc task reply referenced heading counts and file output: "${reply.slice(0, 140)}"`;
    });

    await runStory(page, 'HP-33', 'Agent returns downloadable file from tool execution', async () => {
      await startFreshChat(page);
      await sendChatMessage(page, 'Create a JSON file with 5 sample product entries (name, price, category) and give me the file.');
      const reply = await waitForAnyAssistantFeedback(page, 30000);
      if (!/\.json|json file|\/tmp\/|\/Users\//i.test(reply)) {
        throw new Error(`Response did not include JSON file output details. Last response: ${reply}`);
      }
      return `Agent returned JSON-file-related output: "${reply.slice(0, 140)}"`;
    });

    await runStory(page, 'HP-34', 'Agent handles mixed browser + file multi-step task', async () => {
      await startFreshChat(page);
      await sendChatMessage(page, 'Find the top 3 trending articles on Hacker News, summarize each in one sentence, and save the summaries as a markdown file.');
      const reply = await waitForAnyAssistantFeedback(page, 45000);
      if (!/hacker news|markdown|\.md|summary|summaries/i.test(reply)) {
        throw new Error(`Response did not show expected multi-step browser + markdown outcome. Last response: ${reply}`);
      }
      return `Agent returned multi-step task output: "${reply.slice(0, 140)}"`;
    });

    await runStory(page, 'HP-35', 'Manus configured flow', async () => {
      await page.goto(`${BASE_URL}/manus`, { waitUntil: 'domcontentloaded' });
      if (await page.getByText(/not configured/i).count()) {
        const warning = (await page.locator('text=/not configured/i').first().textContent()) || 'Manus not configured';
        throw new Error(`Manus page reported unconfigured state: ${warning}`);
      }
      await page.getByPlaceholder(/e.g., Scrape the top 10 products/).fill(
        'Find top 5 ergonomic office chairs under $300 and summarize pros/cons.'
      );
      await page.getByRole('button', { name: 'Start Task' }).click();
      await page.waitForURL(/\/executions\/\d+/, { timeout: 20000 });
      return 'Manus task started and redirected to execution route.';
    });

    await runStory(page, 'EE-01', 'Skill run modal missing required inputs', async () => {
      if (!state.templateRecipeId) throw new Error('Missing templateRecipeId precondition.');
      await page.goto(`${BASE_URL}/skills/${state.templateRecipeId}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /^Run$/ }).first().click();
      await page.getByRole('button', { name: /^Run$/ }).last().click();
      await page.getByText(/Please fill in all required fields/i).waitFor({ timeout: 8000 });
      return 'Missing-input validation message appeared in run modal.';
    });

    await runStory(page, 'EE-02', 'Manus not-configured guardrail', async () => {
      await page.goto(`${BASE_URL}/manus`, { waitUntil: 'domcontentloaded' });
      const notConfigured = page.getByText(/not configured/i);
      if (!(await notConfigured.count())) {
        throw new Error('Manus page did not show not-configured warning; expected this environment to be unconfigured.');
      }
      return 'Manus page displayed not-configured warning state.';
    });

    await runStory(page, 'EE-03', '404 route fallback', async () => {
      await page.goto(`${BASE_URL}/not-a-real-page`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Page Not Found' }).waitFor({ timeout: 8000 });
      await page.getByText("The page you're looking for doesn't exist.").waitFor({ timeout: 8000 });
      return '404 page heading and message were displayed.';
    });

    await runStory(page, 'EE-04', 'No provider configured should return explicit error', async () => {
      const plugins = await api('GET', '/plugins');
      const providers = plugins.filter((p) => p.type === 'provider');
      const original = providers.map((p) => ({ name: p.name, enabled: p.enabled, config: p.config }));

      try {
        for (const p of providers) {
          await api('PUT', `/plugins/${p.name}`, { enabled: false, config: p.config || {} });
        }
        await startFreshChat(page);
        await sendChatMessage(page, 'Say hello.');
        const reply = await waitForAnyAssistantFeedback(page, 25000);
        if (!/No LLM provider available\. Please configure an API key\./i.test(reply)) {
          throw new Error(`Expected explicit no-provider message; got: ${reply}`);
        }
        return 'Chat returned explicit no-provider error message.';
      } finally {
        for (const p of original) {
          await api('PUT', `/plugins/${p.name}`, { enabled: p.enabled, config: p.config || {} });
        }
      }
    });

    await runStory(page, 'EE-05', 'Long message handling in chat', async () => {
      await startFreshChat(page);
      const longPrompt = 'L'.repeat(11050);
      await sendChatMessage(page, longPrompt);
      const lastUserBubbleText = (await page.locator('div.bg-primary-600.text-white').last().textContent()) || '';
      if (lastUserBubbleText.length < 10000) {
        throw new Error(`User bubble appears truncated. Observed length=${lastUserBubbleText.length}`);
      }
      const reply = await waitForAnyAssistantFeedback(page, 30000);
      if (/error:|failed to send message/i.test(reply)) {
        throw new Error(`Long message did not process normally. Last response: ${reply}`);
      }
      return `Long prompt rendered in user bubble (length=${lastUserBubbleText.length}) and assistant responded.`;
    });

    await runStory(page, 'EE-06', 'Max tool execution rounds graceful stop', async () => {
      await startFreshChat(page);
      await sendChatMessage(page, 'Use tools repeatedly in a loop and keep calling them forever without finishing.');
      const reply = await waitForAnyAssistantFeedback(page, 60000);
      if (!/Reached maximum tool execution rounds\. Please try a simpler request\./i.test(reply)) {
        throw new Error(`Expected max-tool-rounds guardrail message; got: ${reply}`);
      }
      return 'Agent returned maximum tool rounds guardrail message.';
    });

    await runStory(page, 'EE-07', 'Browser tool failure should be graceful', async () => {
      await startFreshChat(page);
      await sendChatMessage(page, 'Go to https://this-domain-does-not-exist-12345.com');
      const reply = await waitForAnyAssistantFeedback(page, 30000);
      if (!/ERR_NAME_NOT_RESOLVED|Browser error|could not resolve|net::ERR_NAME_NOT_RESOLVED/i.test(reply)) {
        throw new Error(`Expected graceful browser failure details; got: ${reply}`);
      }
      return `Agent returned browser failure details: "${reply.slice(0, 140)}"`;
    });

    await runStory(page, 'EE-08', 'Disabled browser plugin tool unavailability', async () => {
      const plugins = await api('GET', '/plugins');
      const browserPlugin = plugins.find((p) => p.name === 'tool-browser');
      if (!browserPlugin) {
        throw new Error('tool-browser plugin was not found in plugin registry.');
      }
      const original = { enabled: browserPlugin.enabled, config: browserPlugin.config };

      try {
        await api('PUT', '/plugins/tool-browser', { enabled: false, config: browserPlugin.config || {} });
        await startFreshChat(page);
        await sendChatMessage(page, 'Browse https://www.example.com and summarize the page.');
        const reply = await waitForAnyAssistantFeedback(page, 30000);
        if (!/cannot access browser|browser tool.*disabled|tool-browser.*disabled|no browser tool/i.test(reply)) {
          throw new Error(`Expected explicit disabled-tool response; got: ${reply}`);
        }
        return 'Agent reported browser tool unavailability when plugin was disabled.';
      } finally {
        await api('PUT', '/plugins/tool-browser', { enabled: original.enabled, config: original.config || {} });
      }
    });
  } finally {
    await context.close();
    await browser.close();
  }

  const expectedIds = await expectedStoryIdsFromDoc();
  if (!selectedIds) {
    addMissingResultEntries(expectedIds);
  }
  const idOrder = new Map(expectedIds.map((id, idx) => [id, idx]));
  results.sort((a, b) => (idOrder.get(a.id) ?? 9999) - (idOrder.get(b.id) ?? 9999));

  await fs.writeFile(
    RESULTS_PATH,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      stories: results,
    }, null, 2),
    'utf8'
  );

  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\nFinished user stories run. PASS=${passCount}, FAIL=${failCount}`);
  console.log(`Results written to ${RESULTS_PATH}`);
}

main().catch(async (err) => {
  console.error(err);
  await fs.writeFile(
    RESULTS_PATH,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      fatalError: err && err.message ? err.message : String(err),
      stories: results,
    }, null, 2),
    'utf8'
  );
  process.exit(1);
});
