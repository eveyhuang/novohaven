#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs/promises');
const path = require('path');

const RESULTS_PATH = path.join(process.cwd(), 'e2e', 'story-results.json');
const DOC_PATH = process.env.STORY_DOC_PATH
  ? path.resolve(process.cwd(), process.env.STORY_DOC_PATH)
  : path.join(process.cwd(), 'docs', 'user-stories-web-tests.md');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeOneLine(text) {
  return String(text || '')
    .replace(/\u001B\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, ' ')
    .trim();
}

async function main() {
  const [resultsRaw, docRaw] = await Promise.all([
    fs.readFile(RESULTS_PATH, 'utf8'),
    fs.readFile(DOC_PATH, 'utf8'),
  ]);

  const resultsJson = JSON.parse(resultsRaw);
  const stories = resultsJson.stories || [];
  const date = new Date(resultsJson.generatedAt || Date.now()).toISOString().slice(0, 10);

  let doc = docRaw;

  for (const story of stories) {
    const id = story.id;
    const sectionRegex = new RegExp(
      `(^###\\s+${escapeRegExp(id)}\\b[^\\n]*\\n[\\s\\S]*?)(?=^###\\s+[A-Za-z0-9-]+\\b|^##\\s|\\Z)`,
      'm'
    );
    const match = doc.match(sectionRegex);
    if (!match) continue;

    let section = match[1];

    const markerRegex = new RegExp(
      `\\n<!-- TEST_RESULT_START:${escapeRegExp(id)} -->[\\s\\S]*?<!-- TEST_RESULT_END:${escapeRegExp(id)} -->\\n?`,
      'gm'
    );
    section = section.replace(markerRegex, '\n').trimEnd();

    const observed = sanitizeOneLine(story.detail);
    const screenshotLine = story.screenshot
      ? `\n**Screenshot:** \`${story.screenshot}\``
      : '';

    const resultBlock =
      `\n\n<!-- TEST_RESULT_START:${id} -->\n` +
      `**Automated Test Result (${date}):** ${story.status}\n` +
      `**Observed:** ${observed}${screenshotLine}\n` +
      `<!-- TEST_RESULT_END:${id} -->`;

    const updatedSection = `${section}${resultBlock}\n`;
    doc = doc.replace(sectionRegex, updatedSection);
  }

  await fs.writeFile(DOC_PATH, doc, 'utf8');
  console.log(`Updated ${DOC_PATH} with ${stories.length} test result blocks.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
